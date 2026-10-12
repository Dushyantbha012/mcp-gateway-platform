import { sql, type Kysely } from "kysely";

/**
 * Upstream credentials move out of Postgres into Kubernetes Secrets. This
 * step only adds the flag that says "this server has a credential" and makes
 * the constraint use it; the encrypted column stays (nullable) until the
 * gateway has copied every value into a Secret on startup. Dropping it is the
 * next migration, in a later release, so rolling back one release never
 * loses a credential.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table mcp_servers add column has_credential boolean not null default false;
    update mcp_servers set has_credential = (credential_ciphertext is not null);
    -- The old check was unnamed, so find it by what it says.
    do $$
    declare c text;
    begin
      for c in select conname from pg_constraint
               where conrelid = 'mcp_servers'::regclass and contype = 'c'
                 and pg_get_constraintdef(oid) like '%credential_ciphertext%'
      loop
        execute format('alter table mcp_servers drop constraint %I', c);
      end loop;
    end $$;
    alter table mcp_servers add constraint mcp_servers_credential_check
      check (auth_type = 'none' or has_credential or credential_ciphertext is not null);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table mcp_servers drop constraint mcp_servers_credential_check;
    alter table mcp_servers add constraint mcp_servers_credential_ciphertext_check
      check (auth_type = 'none' or credential_ciphertext is not null);
    alter table mcp_servers drop column has_credential;
  `.execute(db);
}
