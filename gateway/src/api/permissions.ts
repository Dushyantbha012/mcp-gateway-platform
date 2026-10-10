import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";
import { principalOf, requireAdmin } from "../auth/middleware.js";
import type { Db } from "../db/db.js";
import { deleteRule, listPermissionRows, toRule, upsertRule } from "../db/permissions.js";
import { getServerBySlug, listServers } from "../db/servers.js";
import { getUser, listUsers } from "../db/users.js";
import { decide } from "../permissions/evaluate.js";
import { buildToolIndex } from "../upstreams/naming.js";
import { HttpError, notFound, parse } from "./errors.js";

const ruleSchema = z
  .object({
    // Admins are never restricted, so "admin" isn't a valid role target.
    role: z.literal("member").optional(),
    userId: z.uuid().optional(),
    serverSlug: z.string().min(1).max(31),
    toolName: z.string().min(1).max(200).nullable().default(null),
    effect: z.enum(["allow", "deny"]),
  })
  .strict()
  .refine((r) => (r.role === undefined) !== (r.userId === undefined), {
    message: "give exactly one of role or userId",
  });

/**
 * Admin-only management of tool permissions. Members never see the rules (or
 * learn that they exist, beyond a missing tool or a denied call).
 */
export function permissionsApi(db: Db) {
  const api = express.Router();
  api.use(requireAdmin);

  api.get("/", async (_req, res) => {
    const [rows, users] = await Promise.all([listPermissionRows(db), listUsers(db)]);
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json(
      rows.map((r) => {
        const user = r.user_id ? byId.get(r.user_id) : undefined;
        return {
          id: r.id,
          subject: r.user_id
            ? { type: "user", userId: r.user_id, email: user?.email, name: user?.name }
            : { type: "role", role: r.role },
          serverSlug: r.server_slug,
          toolName: r.tool_name,
          effect: r.effect,
          createdAt: r.created_at,
        };
      }),
    );
  });

  /** Create a rule, or change the effect of the existing one for the same subject and target. */
  api.put("/", async (req, res) => {
    const body = parse(ruleSchema, req.body);
    if (!(await getServerBySlug(db, body.serverSlug))) {
      throw new HttpError(400, "invalid_request", `No server with slug '${body.serverSlug}'`);
    }
    if (body.userId) {
      const user = await getUser(db, body.userId);
      if (!user) throw new HttpError(400, "invalid_request", "No such user");
      if (user.role === "admin") {
        throw new HttpError(400, "invalid_request", "Admins aren't restricted by permissions");
      }
    }
    const row = await upsertRule(db, { ...body, createdBy: principalOf(res).userId });
    res.json({ id: row.id, effect: row.effect });
  });

  api.delete("/:id", async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success || !(await deleteRule(db, id.data))) throw notFound("Rule");
    res.status(204).end();
  });

  /**
   * What a subject would get from tools/list: every tool of every enabled
   * server with the decision on it and why. `?userId=` previews one member,
   * `?role=member` the role as a whole (no user rules). Uses the same
   * `decide` as the gateway, so the preview can't drift from the real thing.
   */
  api.get("/effective", async (req, res) => {
    const q = parse(
      z
        .object({ userId: z.uuid().optional(), role: z.enum(["admin", "member"]).optional() })
        .strict()
        .refine((v) => (v.userId === undefined) !== (v.role === undefined), {
          message: "give exactly one of userId or role",
        }),
      req.query,
    );
    // A role preview uses an id no user has, so only the role's rules match.
    let subject = { userId: "", role: q.role ?? ("member" as const) };
    if (q.userId) {
      const user = await getUser(db, q.userId);
      if (!user) throw notFound("User");
      subject = { userId: user.id, role: user.role };
    }
    const [rows, servers] = await Promise.all([listPermissionRows(db), listServers(db)]);
    const rules = rows.map(toRule);
    const out = [];
    for (const server of servers.filter((s) => s.enabled)) {
      const index = buildToolIndex([
        { slug: server.slug, name: server.name, tools: (server.tools_cache ?? []) as Tool[] },
      ]);
      for (const [name, route] of index.routes) {
        const d = decide(subject, { serverSlug: route.slug, toolName: route.upstreamName }, rules);
        out.push({
          name,
          serverSlug: route.slug,
          toolName: route.upstreamName,
          allowed: d.allowed,
          reason: d.reason,
          ...("rule" in d && d.rule
            ? {
                rule: {
                  subjectType: d.rule.subjectType,
                  toolName: d.rule.toolName,
                  effect: d.rule.effect,
                },
              }
            : {}),
        });
      }
    }
    res.json(out);
  });

  return api;
}
