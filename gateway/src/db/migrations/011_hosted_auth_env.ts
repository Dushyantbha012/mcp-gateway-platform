import { sql, type Kysely } from "kysely";

/**
 * HTTP images that check a bearer token: `auth_token_env` names the variable
 * the image reads it from. The provisioner generates the token (like the
 * bridge's) and the gateway sends it; stdio servers always sit behind the
 * bridge's token instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table hosted_servers add column auth_token_env text
      check (auth_token_env ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$');
    alter table hosted_servers add constraint hosted_servers_auth_token_env_http
      check (auth_token_env is null or transport = 'http');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table hosted_servers drop column auth_token_env`.execute(db);
}
