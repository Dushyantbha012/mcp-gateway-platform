import { sql, type Kysely } from "kysely";

/**
 * Free-text context for an audit row that isn't an error: today, the query of a
 * `search_tools` call and how many tools it matched. Nullable - ordinary tool
 * calls have nothing to add, and older rows have none.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table audit_log add column detail text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table audit_log drop column detail`.execute(db);
}
