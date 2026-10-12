import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";
import { principalOf, requireAdmin } from "../auth/middleware.js";
import type { SecretBox } from "../crypto/secretBox.js";
import type { Db } from "../db/db.js";
import type { McpServer, McpServerUpdate } from "../db/schema.js";
import { deleteRulesForServer, renameServerRules } from "../db/permissions.js";
import { deleteServer, getServer, insertServer, listServers, updateServer } from "../db/servers.js";
import { displayStatus, type HealthChecker } from "../upstreams/health.js";
import { checkUrl, SsrfError, type SsrfPolicy } from "../security/ssrf.js";
import { buildToolIndex, SLUG_PATTERN } from "../upstreams/naming.js";
import type { UpstreamRegistry } from "../upstreams/registry.js";
import { conflictOnDuplicate, HttpError, notFound, parse } from "./errors.js";

// Headers the transport itself controls; letting an admin set them as the
// "credential header" would break or hijack the MCP session.
const RESERVED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "accept",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "must be a valid HTTP header name")
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), "is reserved by the MCP transport");

const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

const fields = {
  slug: z.string().regex(SLUG_PATTERN, "must be 2-31 chars: lowercase letters, digits, dashes"),
  name: z.string().trim().min(1).max(100),
  url: httpUrl,
  enabled: z.boolean(),
  authType: z.enum(["none", "bearer", "header"]),
  authHeaderName: headerName.nullable(),
  credential: z.string().min(1).max(4096).nullable(),
  timeoutMs: z.number().int().min(100).max(120_000),
};

const createSchema = z.object({
  ...fields,
  enabled: fields.enabled.default(true),
  authType: fields.authType.default("none"),
  authHeaderName: fields.authHeaderName.optional(),
  credential: fields.credential.optional(),
  timeoutMs: fields.timeoutMs.default(10_000),
});

const updateSchema = z.object(fields).partial().strict();

/**
 * API view of a server. The credential is never included - not even
 * encrypted - only whether one is set. Members also don't see the upstream
 * URL: they use tools through the gateway and never need to reach a server
 * directly.
 */
export function serverView(server: McpServer, opts: { admin: boolean }) {
  const index = buildToolIndex([
    { slug: server.slug, name: server.name, tools: (server.tools_cache ?? []) as Tool[] },
  ]);
  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    ...(opts.admin ? { url: server.url } : {}),
    enabled: server.enabled,
    status: displayStatus(server),
    lastError: server.last_error,
    lastCheckedAt: server.last_checked_at,
    authType: server.auth_type,
    authHeaderName: server.auth_header_name,
    hasCredential: server.credential_ciphertext !== null,
    timeoutMs: server.timeout_ms,
    tools: index.tools.map((t) => ({
      name: t.name,
      upstreamName: index.routes.get(t.name)!.upstreamName,
      description: t.description,
    })),
    createdAt: server.created_at,
    updatedAt: server.updated_at,
  };
}

/** Auth type, header name and credential must agree (mirrors the DB checks, with clear messages). */
function checkAuth(authType: string, headerName: string | null, hasCredential: boolean) {
  if (authType === "header" && !headerName) {
    throw new HttpError(
      400,
      "invalid_request",
      "authHeaderName is required when authType is 'header'",
    );
  }
  if (authType !== "none" && !hasCredential) {
    throw new HttpError(
      400,
      "invalid_request",
      `credential is required when authType is '${authType}'`,
    );
  }
}

export function serversApi(deps: {
  db: Db;
  box: SecretBox;
  registry: UpstreamRegistry;
  health: HealthChecker;
  ssrf: SsrfPolicy;
}) {
  const { db, box, registry, health, ssrf } = deps;
  const api = express.Router();

  const load = async (id: unknown) => {
    const parsed = z.uuid().safeParse(id);
    const server = parsed.success ? await getServer(db, parsed.data) : undefined;
    if (!server) throw notFound("Server");
    return server;
  };

  /** Refuses URLs that point at internal services (see security/ssrf.ts). */
  const checkTarget = async (url: string) => {
    try {
      await checkUrl(url, ssrf);
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new HttpError(400, "url_not_allowed", `The server URL ${err.message}`);
      }
      throw err;
    }
  };

  api.get("/", async (_req, res) => {
    const admin = principalOf(res).role === "admin";
    res.json((await listServers(db)).map((s) => serverView(s, { admin })));
  });

  api.get("/:id", async (req, res) => {
    const admin = principalOf(res).role === "admin";
    res.json(serverView(await load(req.params.id), { admin }));
  });

  api.post("/", requireAdmin, async (req, res) => {
    const body = parse(createSchema, req.body);
    const headerName = body.authType === "header" ? (body.authHeaderName ?? null) : null;
    const credential = body.authType === "none" ? null : (body.credential ?? null);
    checkAuth(body.authType, headerName, credential !== null);
    await checkTarget(body.url);
    const id = randomUUID(); // known up front: it's the credential's associated data
    const created = await insertServer(db, {
      id,
      slug: body.slug,
      name: body.name,
      url: body.url,
      enabled: body.enabled,
      auth_type: body.authType,
      auth_header_name: headerName,
      credential_ciphertext: credential === null ? null : box.encrypt(credential, id),
      timeout_ms: body.timeoutMs,
    }).catch(conflictOnDuplicate(`A server with slug '${body.slug}'`));
    // Check it right away so the response already says Connected/Unreachable.
    const checked = created.enabled ? await health.check(created) : created;
    res.status(201).json(serverView(checked, { admin: true }));
  });

  api.patch("/:id", requireAdmin, async (req, res) => {
    const current = await load(req.params.id);
    const body = parse(updateSchema, req.body);
    const authType = body.authType ?? current.auth_type;
    const changes: McpServerUpdate = {
      slug: body.slug,
      name: body.name,
      url: body.url,
      enabled: body.enabled,
      auth_type: body.authType,
      timeout_ms: body.timeoutMs,
    };
    changes.auth_header_name =
      authType === "header" ? (body.authHeaderName ?? current.auth_header_name) : null;
    if (authType === "none") changes.credential_ciphertext = null;
    else if (body.credential)
      changes.credential_ciphertext = box.encrypt(body.credential, current.id);
    const hasCredential =
      authType !== "none" && (body.credential ? true : current.credential_ciphertext !== null);
    checkAuth(authType, changes.auth_header_name ?? null, hasCredential);
    if (body.url !== undefined) await checkTarget(body.url);

    const updated = await updateServer(db, current.id, changes).catch(
      conflictOnDuplicate(`A server with slug '${body.slug}'`),
    );
    if (!updated) throw notFound("Server");
    if (updated.slug !== current.slug) await renameServerRules(db, current.slug, updated.slug);
    let result = updated;
    if (updated.enabled) result = await health.check(updated);
    else await registry.forget(updated.id);
    res.json(serverView(result, { admin: true }));
  });

  api.delete("/:id", requireAdmin, async (req, res) => {
    const server = await load(req.params.id);
    await deleteServer(db, server.id);
    // A server added later under the same slug must not inherit these rules.
    await deleteRulesForServer(db, server.slug);
    await registry.forget(server.id);
    res.status(204).end();
  });

  api.post("/:id/refresh", requireAdmin, async (req, res) => {
    const server = await load(req.params.id);
    if (!server.enabled) throw new HttpError(409, "conflict", "Server is disabled");
    res.json(serverView(await health.check(server), { admin: true }));
  });

  return api;
}
