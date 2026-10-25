import { sql, type Kysely } from "kysely";

/**
 * Lets an admin vouch that every tool of a server only reads, for upstreams
 * (DeepWiki, ...) that don't send `readOnlyHint`. Without it such tools count
 * as writes and every MCP call waits for a dashboard approval.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table mcp_servers add column read_only boolean not null default false;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table mcp_servers drop column read_only;
  `.execute(db);
}
