import { sql, type Kysely } from "kysely";

/**
 * MCP servers the platform runs from a container image, one namespace each.
 * Like `stores`, a row is the desired state and the provisioner reconciles it
 * into a Deployment and an `mcp_servers` row (managed_by = 'hosted').
 *
 * Secret environment values never reach Postgres: the gateway writes them to
 * a Secret `hosted-env-<id>` next to the upstream credentials, and this row
 * keeps only their names. Creating a row, and every status change, NOTIFYs
 * `hosted_changed`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table hosted_servers (
      id              uuid primary key default gen_random_uuid(),
      slug            text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,30}$'),
      name            text not null check (length(name) between 1 and 100),
      image           text not null check (length(image) between 1 and 255),
      transport       text not null check (transport in ('http', 'stdio')),
      -- stdio: the server's command (run under the bridge); http: an optional
      -- override of the image's entrypoint.
      command         text[] not null default '{}',
      port            integer not null default 8080 check (port between 1 and 65535),
      path            text not null default '/mcp' check (path ~ '^/'),
      libc            text not null default 'glibc' check (libc in ('glibc', 'musl')),
      env             jsonb not null default '{}',
      secret_env_keys text[] not null default '{}',
      egress          text not null default 'none' check (egress in ('none', 'internet')),
      size            text not null default 'small' check (size in ('small', 'medium')),
      status          text not null default 'provisioning'
                      check (status in ('provisioning', 'ready', 'failed', 'deleting')),
      step            text,
      reason          text,
      namespace       text,
      server_id       uuid references mcp_servers (id) on delete set null,
      created_by      uuid references users (id) on delete set null,
      deadline_at     timestamptz,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now(),
      check (transport = 'http' or cardinality(command) > 0)
    );
    create index hosted_servers_pending_idx on hosted_servers (status)
      where status in ('provisioning', 'deleting');

    create function hosted_notify() returns trigger language plpgsql as $$
    begin
      perform pg_notify('hosted_changed', new.id::text);
      return new;
    end $$;
    create trigger hosted_notify_insert after insert on hosted_servers
      for each row execute function hosted_notify();
    create trigger hosted_notify_status after update on hosted_servers
      for each row when (old.status is distinct from new.status)
      execute function hosted_notify();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table hosted_servers;
    drop function hosted_notify();
  `.execute(db);
}
