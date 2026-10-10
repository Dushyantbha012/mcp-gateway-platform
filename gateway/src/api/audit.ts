import express from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { queryAudit } from "../db/audit.js";
import type { Db } from "../db/db.js";
import { parse } from "./errors.js";

const querySchema = z.object({
  userId: z.uuid().optional(),
  server: z.string().max(64).optional(),
  before: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Newest first; page with `?before=<id of the last row seen>`. */
export function auditApi(db: Db) {
  const api = express.Router();
  api.get("/", requireAdmin, async (req, res) => {
    const q = parse(querySchema, req.query);
    const entries = await queryAudit(db, {
      userId: q.userId,
      serverSlug: q.server,
      beforeId: q.before,
      limit: q.limit,
    });
    res.json(
      entries.map((e) => ({
        id: e.id,
        ts: e.ts,
        userId: e.user_id,
        userEmail: e.user_email,
        apiKeyId: e.api_key_id,
        source: e.source,
        server: e.server_slug,
        tool: e.tool_name,
        durationMs: e.duration_ms,
        outcome: e.outcome,
        error: e.error,
      })),
    );
  });
  return api;
}
