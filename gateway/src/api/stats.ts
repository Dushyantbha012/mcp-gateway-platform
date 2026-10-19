import express from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { auditStats } from "../db/audit.js";
import type { Db } from "../db/db.js";
import { parse } from "./errors.js";

const querySchema = z.object({ range: z.enum(["24h", "7d", "30d"]).default("24h") });

const RANGES = {
  "24h": { ms: 24 * 3_600_000, bucket: "hour" },
  "7d": { ms: 7 * 24 * 3_600_000, bucket: "day" },
  "30d": { ms: 30 * 24 * 3_600_000, bucket: "day" },
} as const;

/** Aggregated audit numbers for the dashboard overview. Admin only, like the audit log it reads. */
export function statsApi(db: Db) {
  const api = express.Router();
  api.get("/", requireAdmin, async (req, res) => {
    const { range } = parse(querySchema, req.query);
    const { ms, bucket } = RANGES[range];
    const now = Date.now();
    const stats = await auditStats(db, {
      since: new Date(now - ms),
      previousSince: new Date(now - 2 * ms),
      bucket,
    });
    res.json({ range, bucket, ...stats });
  });
  return api;
}
