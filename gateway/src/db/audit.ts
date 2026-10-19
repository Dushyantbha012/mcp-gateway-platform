import { sql } from "kysely";
import type { Db } from "./db.js";
import type { AuditEntry, AuditOutcome, AuditSource, NewAuditEntry } from "./schema.js";

export async function insertAuditEntry(db: Db, entry: NewAuditEntry): Promise<void> {
  await db.insertInto("audit_log").values(entry).execute();
}

export interface AuditQuery {
  userId?: string;
  serverSlug?: string;
  outcome?: AuditOutcome;
  source?: AuditSource;
  requestId?: string;
  /** Keyset pagination: entries with id lower than this. */
  beforeId?: string;
  limit?: number;
}

export function queryAudit(db: Db, q: AuditQuery = {}): Promise<AuditEntry[]> {
  let query = db.selectFrom("audit_log").selectAll();
  if (q.userId) query = query.where("user_id", "=", q.userId);
  if (q.serverSlug) query = query.where("server_slug", "=", q.serverSlug);
  if (q.outcome) query = query.where("outcome", "=", q.outcome);
  if (q.source) query = query.where("source", "=", q.source);
  if (q.requestId) query = query.where("request_id", "=", q.requestId);
  if (q.beforeId) query = query.where("id", "<", q.beforeId);
  return query
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
    .execute();
}

export interface AuditStats {
  totals: { total: number; errors: number; avgMs: number; p95Ms: number };
  /** Same-length window immediately before `since`, for trend deltas. */
  previous: { total: number; errors: number };
  byOutcome: { outcome: AuditOutcome; count: number }[];
  series: { bucket: string; success: number; errors: number }[];
  topTools: { tool: string; server: string | null; count: number }[];
  topServers: { server: string; count: number }[];
}

/**
 * Aggregates the audit log over `[since, now)`. "Errors" are every outcome
 * except success, rejected (bad input from the caller) and denied (policy
 * working as intended).
 */
export async function auditStats(
  db: Db,
  opts: { since: Date; previousSince: Date; bucket: "hour" | "day" },
): Promise<AuditStats> {
  const { since, previousSince, bucket } = opts;
  const isError = sql<boolean>`outcome not in ('success', 'rejected', 'denied')`;

  const totals = await db
    .selectFrom("audit_log")
    .where("ts", ">=", since)
    .select([
      sql<string>`count(*)`.as("total"),
      sql<string>`count(*) filter (where ${isError})`.as("errors"),
      sql<string | null>`avg(duration_ms)`.as("avg"),
      sql<string | null>`percentile_cont(0.95) within group (order by duration_ms)`.as("p95"),
    ])
    .executeTakeFirstOrThrow();

  const previous = await db
    .selectFrom("audit_log")
    .where("ts", ">=", previousSince)
    .where("ts", "<", since)
    .select([
      sql<string>`count(*)`.as("total"),
      sql<string>`count(*) filter (where ${isError})`.as("errors"),
    ])
    .executeTakeFirstOrThrow();

  const byOutcome = await db
    .selectFrom("audit_log")
    .where("ts", ">=", since)
    .select(["outcome", sql<string>`count(*)`.as("count")])
    .groupBy("outcome")
    .execute();

  const bucketExpr = sql<Date>`date_trunc(${sql.lit(bucket)}, ts)`;
  const series = await db
    .selectFrom("audit_log")
    .where("ts", ">=", since)
    .select([
      bucketExpr.as("bucket"),
      sql<string>`count(*) filter (where outcome = 'success')`.as("success"),
      sql<string>`count(*) filter (where ${isError})`.as("errors"),
    ])
    .groupBy(bucketExpr)
    .orderBy(bucketExpr)
    .execute();

  const topTools = await db
    .selectFrom("audit_log")
    .where("ts", ">=", since)
    .select(["tool_name", "server_slug", sql<string>`count(*)`.as("count")])
    .groupBy(["tool_name", "server_slug"])
    .orderBy(sql`count(*)`, "desc")
    .limit(8)
    .execute();

  const topServers = await db
    .selectFrom("audit_log")
    .where("ts", ">=", since)
    .where("server_slug", "is not", null)
    .select(["server_slug", sql<string>`count(*)`.as("count")])
    .groupBy("server_slug")
    .orderBy(sql`count(*)`, "desc")
    .limit(8)
    .execute();

  return {
    totals: {
      total: Number(totals.total),
      errors: Number(totals.errors),
      avgMs: Math.round(Number(totals.avg ?? 0)),
      p95Ms: Math.round(Number(totals.p95 ?? 0)),
    },
    previous: { total: Number(previous.total), errors: Number(previous.errors) },
    byOutcome: byOutcome.map((r) => ({ outcome: r.outcome, count: Number(r.count) })),
    series: series.map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      success: Number(r.success),
      errors: Number(r.errors),
    })),
    topTools: topTools.map((r) => ({
      tool: r.tool_name,
      server: r.server_slug,
      count: Number(r.count),
    })),
    topServers: topServers.map((r) => ({ server: r.server_slug!, count: Number(r.count) })),
  };
}
