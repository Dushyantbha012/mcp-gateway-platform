import { sql, type Kysely } from "kysely";

/**
 * The second half of moving credentials into Kubernetes Secrets: the
 * encrypted column is gone. Release 004 copied every value into a Secret at
 * startup and cleared the column, so by the time this runs the column only
 * holds NULLs. If it somehow still holds a value, refuse: dropping it would
 * lose a credential, and that is never a migration's call to make.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const left = await sql<{ n: string }>`
    select count(*)::text as n from mcp_servers where credential_ciphertext is not null
  `.execute(db);
  if (Number(left.rows[0].n) > 0) {
    throw new Error(
      "mcp_servers still has encrypted credentials; run the previous gateway release " +
        "(004) once so it moves them into Kubernetes Secrets, then upgrade",
    );
  }
  await sql`
    alter table mcp_servers drop constraint mcp_servers_credential_check;
    alter table mcp_servers drop column credential_ciphertext;
    alter table mcp_servers add constraint mcp_servers_credential_check
      check (auth_type = 'none' or has_credential);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The values themselves are in Secrets; the column comes back empty.
  await sql`
    alter table mcp_servers drop constraint mcp_servers_credential_check;
    alter table mcp_servers add column credential_ciphertext bytea;
    alter table mcp_servers add constraint mcp_servers_credential_check
      check (auth_type = 'none' or has_credential or credential_ciphertext is not null);
  `.execute(db);
}
