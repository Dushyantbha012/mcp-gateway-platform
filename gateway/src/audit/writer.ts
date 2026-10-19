import type { Principal } from "../db/apiKeys.js";
import { insertAuditEntry } from "../db/audit.js";
import type { Db } from "../db/db.js";
import type { AuditOutcome, AuditSource } from "../db/schema.js";
import { log } from "../logger.js";

export interface AuditRecord {
  principal: Principal;
  source: AuditSource;
  serverSlug: string | null;
  toolName: string;
  durationMs: number;
  outcome: AuditOutcome;
  error?: string;
  requestId?: string;
  /** Non-error context shown next to the tool, e.g. a search query. */
  detail?: string;
}

/**
 * Writes one audit row. Awaited by the caller, so a tool call can't return
 * before its row exists. If the insert itself fails, that's logged loudly
 * but the user's call still returns: losing an audit row is bad, failing a
 * tool call that already ran upstream (e.g. created a product) is worse.
 */
export async function writeAudit(db: Db, record: AuditRecord): Promise<void> {
  try {
    await insertAuditEntry(db, {
      user_id: record.principal.userId,
      user_email: record.principal.email,
      api_key_id: record.principal.keyId,
      source: record.source,
      server_slug: record.serverSlug,
      tool_name: record.toolName,
      duration_ms: Math.round(record.durationMs),
      outcome: record.outcome,
      error: record.error?.slice(0, 1000) ?? null,
      request_id: record.requestId ?? null,
      detail: record.detail?.slice(0, 500) ?? null,
    });
  } catch (err) {
    log("error", "audit write failed", {
      error: err instanceof Error ? err.message : String(err),
      user: record.principal.email,
      tool: record.toolName,
      outcome: record.outcome,
    });
  }
}
