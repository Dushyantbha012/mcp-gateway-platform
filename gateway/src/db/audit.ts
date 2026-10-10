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
  if (q.beforeId) query = query.where("id", "<", q.beforeId);
  return query
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
    .execute();
}
