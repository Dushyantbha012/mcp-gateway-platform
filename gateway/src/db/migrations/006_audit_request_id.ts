import { sql, type Kysely } from "kysely";

/**
 * Ties an audit row to the request that produced it, so one `X-Request-ID` can
 * be followed from the logs to the audit log. Nullable: rows written before
 * this migration, and calls made outside a request, have none.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table audit_log add column request_id text;
    create index audit_log_request_id_idx on audit_log (request_id) where request_id is not null;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index audit_log_request_id_idx;
    alter table audit_log drop column request_id;
  `.execute(db);
}
