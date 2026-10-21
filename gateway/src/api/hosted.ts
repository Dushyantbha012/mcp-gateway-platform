import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { writeAudit } from "../audit/writer.js";
import { principalOf, requireAdmin } from "../auth/middleware.js";
import type { HostedEnvStore } from "../credentials/hostedEnv.js";
import type { Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import {
  createHosted,
  getHostedWithCreator,
  listHosted,
  SlugTakenError,
  transitionHosted,
  type HostedWithCreator,
} from "../db/hosted.js";
import type { HostedServer, HostedServerUpdate } from "../db/schema.js";
import { checkImage, ImageNotAllowedError } from "../hosted/image.js";
import { currentRequestId } from "../requestContext.js";
import { SLUG_PATTERN } from "../upstreams/naming.js";
import { HttpError, notFound, parse } from "./errors.js";

export interface HostedConfig {
  /** Off = the list still answers, but nothing can be created or changed. */
  enabled: boolean;
  imageAllowlist: string[];
  timeoutSeconds: number;
}

/** The bridge reads BRIDGE_* itself and never passes them on; the server can't set them. */
const RESERVED_ENV = /^BRIDGE_/;
const MAX_ENV = 50;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const envValue = z.string().max(4096);
/** zod reports a bad record key only as "Invalid key"; this says which and why. */
const envRecord = <V extends z.ZodType>(value: V) =>
  z.record(z.string(), value).superRefine((m, ctx) => {
    const keys = Object.keys(m);
    if (keys.length > MAX_ENV)
      ctx.addIssue({ code: "custom", message: `at most ${MAX_ENV} variables` });
    for (const k of keys) {
      if (!ENV_NAME.test(k)) {
        ctx.addIssue({
          code: "custom",
          path: [k],
          message: "must be a valid environment variable name",
        });
      } else if (RESERVED_ENV.test(k)) {
        ctx.addIssue({
          code: "custom",
          path: [k],
          message: "BRIDGE_* variables are reserved for the bridge",
        });
      }
    }
  });
const envMap = envRecord(envValue);

const fields = {
  slug: z.string().regex(SLUG_PATTERN, "must be 2-31 chars: lowercase letters, digits, dashes"),
  name: z.string().trim().min(1).max(100),
  image: z.string().trim().min(1).max(255),
  transport: z.enum(["http", "stdio"]),
  command: z.array(z.string().min(1).max(1024)).max(32),
  port: z.number().int().min(1).max(65535),
  path: z
    .string()
    .regex(/^\/[A-Za-z0-9._~/-]*$/, "must be a URL path starting with /")
    .max(255),
  libc: z.enum(["glibc", "musl"]),
  env: envMap,
  egress: z.enum(["none", "internet"]),
  size: z.enum(["small", "medium"]),
  /** http only: the variable the image reads its bearer token from; the provisioner generates the token. */
  authTokenEnv: z
    .string()
    .regex(ENV_NAME, "must be a valid environment variable name")
    .refine((k) => !RESERVED_ENV.test(k), "BRIDGE_* variables are reserved for the bridge")
    .nullable(),
};

const createSchema = z
  .object({
    ...fields,
    command: fields.command.default([]),
    port: fields.port.default(8080),
    path: fields.path.default("/mcp"),
    libc: fields.libc.default("glibc"),
    env: fields.env.default({}),
    secretEnv: envMap.default({}),
    egress: fields.egress.default("none"),
    size: fields.size.default("small"),
    authTokenEnv: fields.authTokenEnv.default(null),
  })
  .strict();

/**
 * Slug and transport are fixed: changing either makes it a different server
 * (new tool names, a different pod shape), so that's delete and create.
 * `secretEnv` merges: a value sets that variable, null removes it, and
 * variables not mentioned keep their stored value.
 */
const updateSchema = z
  .object({
    name: fields.name,
    image: fields.image,
    command: fields.command,
    port: fields.port,
    path: fields.path,
    libc: fields.libc,
    env: fields.env,
    secretEnv: envRecord(envValue.nullable()),
    egress: fields.egress,
    size: fields.size,
    authTokenEnv: fields.authTokenEnv,
  })
  .partial()
  .strict();

/** Checks that apply to the server as a whole, after defaults or a merge. */
function checkSpec(spec: {
  transport: string;
  command: string[];
  envKeys: string[];
  secretKeys: string[];
  authTokenEnv: string | null;
}) {
  if (spec.authTokenEnv && spec.transport !== "http") {
    throw new HttpError(
      400,
      "invalid_request",
      "authTokenEnv is for http servers: stdio servers sit behind the bridge's own token",
    );
  }
  if (
    spec.authTokenEnv &&
    (spec.envKeys.includes(spec.authTokenEnv) || spec.secretKeys.includes(spec.authTokenEnv))
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      `${spec.authTokenEnv} is set by the provisioner (authTokenEnv); don't set it yourself`,
    );
  }
  if (spec.transport === "stdio" && spec.command.length === 0) {
    throw new HttpError(
      400,
      "invalid_request",
      "command is required for a stdio server: the bridge runs it in place of the image's entrypoint",
    );
  }
  const both = spec.envKeys.filter((k) => spec.secretKeys.includes(k));
  if (both.length) {
    throw new HttpError(
      400,
      "invalid_request",
      `${both.join(", ")} can't be both a plain and a secret variable`,
    );
  }
  if (spec.envKeys.length + spec.secretKeys.length > MAX_ENV) {
    throw new HttpError(400, "invalid_request", `at most ${MAX_ENV} variables in all`);
  }
}

/**
 * API view of a hosted server. Secret variables appear by name only; their
 * values are write-only, like upstream credentials.
 */
export function hostedView(h: HostedWithCreator) {
  return {
    id: h.id,
    slug: h.slug,
    name: h.name,
    image: h.image,
    transport: h.transport,
    command: h.command,
    port: h.port,
    path: h.path,
    libc: h.libc,
    env: h.env,
    secretEnvKeys: h.secret_env_keys,
    authTokenEnv: h.auth_token_env,
    egress: h.egress,
    size: h.size,
    status: h.status,
    step: h.step,
    reason: h.reason,
    namespace: h.namespace,
    serverId: h.server_id,
    createdBy: h.created_by ? { id: h.created_by, email: h.created_by_email } : null,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}

/**
 * Hosted MCP servers: admins only, since an image is code the cluster runs.
 * Like stores, the API records intent and the provisioner does the work,
 * reporting back on the same row.
 */
export function hostedApi(db: Db, secrets: HostedEnvStore, config: HostedConfig) {
  const api = express.Router();
  api.use(requireAdmin);

  const load = async (id: unknown) => {
    const parsed = z.uuid().safeParse(id);
    const hosted = parsed.success ? await getHostedWithCreator(db, parsed.data) : undefined;
    if (!hosted) throw notFound("Hosted server");
    return hosted;
  };
  const audit = (
    who: Principal,
    action: string,
    hosted: Pick<HostedServer, "slug" | "image">,
    outcome: "success" | "rejected" = "success",
    error?: string,
  ) =>
    writeAudit(db, {
      principal: who,
      source: "dashboard",
      serverSlug: hosted.slug,
      toolName: `hosted.${action}`,
      durationMs: 0,
      outcome,
      error,
      detail: hosted.image,
      requestId: currentRequestId(),
    });
  const requireEnabled = () => {
    if (!config.enabled) {
      throw new HttpError(
        503,
        "hosted_disabled",
        "Hosted MCP servers are not enabled on this gateway",
      );
    }
  };
  const allowedImage = async (who: Principal, slug: string, image: string) => {
    try {
      checkImage(image, config.imageAllowlist);
    } catch (err) {
      if (!(err instanceof ImageNotAllowedError)) throw err;
      await audit(who, "image_refused", { slug, image }, "rejected", err.message);
      throw new HttpError(400, "image_not_allowed", err.message);
    }
  };
  const view = (h: HostedServer, who: Principal, email?: string | null) =>
    hostedView({
      ...h,
      created_by_email: email ?? (h.created_by === who.userId ? who.email : null),
    });
  const deadline = () => new Date(Date.now() + config.timeoutSeconds * 1000);

  api.get("/", async (_req, res) => {
    res.json({
      enabled: config.enabled,
      imageAllowlist: config.imageAllowlist,
      servers: (await listHosted(db)).map(hostedView),
    });
  });

  api.get("/:id", async (req, res) => {
    res.json(hostedView(await load(req.params.id)));
  });

  api.post("/", async (req, res) => {
    const who = principalOf(res);
    requireEnabled();
    const body = parse(createSchema, req.body);
    const secretKeys = Object.keys(body.secretEnv);
    checkSpec({
      transport: body.transport,
      command: body.command,
      envKeys: Object.keys(body.env),
      secretKeys,
      authTokenEnv: body.authTokenEnv,
    });
    await allowedImage(who, body.slug, body.image);

    const id = randomUUID(); // names the Secret, so known before the row
    // Secret first, row second: the provisioner may pick the row up at once
    // (NOTIFY), and must find the values already there.
    if (secretKeys.length) await secrets.put(id, body.secretEnv);
    let created: HostedServer;
    try {
      created = await createHosted(db, {
        id,
        slug: body.slug,
        name: body.name,
        image: body.image,
        transport: body.transport,
        command: body.command,
        port: body.port,
        path: body.path,
        libc: body.libc,
        env: JSON.stringify(body.env),
        secret_env_keys: secretKeys,
        auth_token_env: body.authTokenEnv,
        egress: body.egress,
        size: body.size,
        created_by: who.userId,
        step: "queued",
        deadline_at: deadline(),
      });
    } catch (err) {
      if (secretKeys.length) await secrets.delete(id).catch(() => undefined);
      if (err instanceof SlugTakenError) throw new HttpError(409, "conflict", err.message);
      if ((err as { code?: string }).code === "23505") {
        throw new HttpError(409, "conflict", `The name '${body.slug}' is already in use`);
      }
      throw err;
    }
    await audit(who, "create", created);
    res.status(201).json(view(created, who));
  });

  api.patch("/:id", async (req, res) => {
    const who = principalOf(res);
    requireEnabled();
    const current = await load(req.params.id);
    if (current.status === "deleting") {
      throw new HttpError(409, "conflict", "The server is being deleted");
    }
    const body = parse(updateSchema, req.body);
    if (body.image !== undefined) await allowedImage(who, current.slug, body.image);

    let secretKeys = current.secret_env_keys;
    let previous: Record<string, string> | null = null;
    let merged: Record<string, string> | null = null;
    if (body.secretEnv) {
      previous = await secrets.get(current.id);
      merged = { ...(previous ?? {}) };
      for (const [k, v] of Object.entries(body.secretEnv)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      secretKeys = Object.keys(merged);
    }
    const command = body.command ?? current.command;
    const env = body.env ?? current.env;
    checkSpec({
      transport: current.transport,
      command,
      envKeys: Object.keys(env),
      secretKeys,
      authTokenEnv: body.authTokenEnv !== undefined ? body.authTokenEnv : current.auth_token_env,
    });

    const changes: HostedServerUpdate = {
      name: body.name,
      image: body.image,
      command: body.command,
      port: body.port,
      path: body.path,
      libc: body.libc,
      env: body.env ? JSON.stringify(body.env) : undefined,
      secret_env_keys: secretKeys,
      egress: body.egress,
      size: body.size,
      auth_token_env: body.authTokenEnv,
    };
    // Only a name change leaves the pod alone; anything else is re-applied.
    const respec =
      Object.entries(changes).some(
        ([k, v]) => v !== undefined && k !== "name" && k !== "secret_env_keys",
      ) || body.secretEnv !== undefined;

    if (merged) {
      if (Object.keys(merged).length) await secrets.put(current.id, merged);
      else await secrets.delete(current.id);
    }
    const updated = await transitionHosted(
      db,
      current.id,
      ["provisioning", "ready", "failed"],
      respec
        ? {
            ...changes,
            status: "provisioning",
            step: "updating",
            reason: null,
            deadline_at: deadline(),
          }
        : changes,
    );
    if (!updated) {
      // Deleted meanwhile: put the old values back rather than leave half an update.
      if (merged) {
        if (previous) await secrets.put(current.id, previous).catch(() => undefined);
        else await secrets.delete(current.id).catch(() => undefined);
      }
      throw new HttpError(409, "conflict", "The server changed meanwhile; try again");
    }
    await audit(who, "update", updated);
    res.json(view(updated, who, current.created_by_email));
  });

  api.delete("/:id", async (req, res) => {
    const who = principalOf(res);
    const current = await load(req.params.id);
    if (current.status === "deleting") return res.status(202).json(hostedView(current));
    // The provisioner removes the namespace, the server row and the Secret.
    const deleting = await transitionHosted(db, current.id, ["provisioning", "ready", "failed"], {
      status: "deleting",
      step: "deleting",
      reason: null,
    });
    if (!deleting) throw new HttpError(409, "conflict", "The server changed meanwhile; try again");
    await audit(who, "delete", current);
    res.status(202).json(view(deleting, who, current.created_by_email));
  });

  api.post("/:id/retry", async (req, res) => {
    const who = principalOf(res);
    requireEnabled();
    const current = await load(req.params.id);
    if (current.status !== "failed") {
      throw new HttpError(409, "conflict", "Only a failed server can be retried");
    }
    const retried = await transitionHosted(db, current.id, ["failed"], {
      status: "provisioning",
      step: "retry",
      reason: null,
      deadline_at: deadline(),
    });
    if (!retried) throw new HttpError(409, "conflict", "The server changed meanwhile; try again");
    await audit(who, "retry", current);
    res.json(view(retried, who, current.created_by_email));
  });

  return api;
}
