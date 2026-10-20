import { sql, type Kysely } from "kysely";

/**
 * Stores created from the dashboard. A row is the desired state; the
 * provisioner (its own pod) reconciles it into a namespace, a WooCommerce
 * install and an MCP server row, and records how far it got in `step`.
 *
 * `mcp_servers.managed_by` marks server rows the provisioner owns: the admin
 * API refuses to edit or delete them, so the two never fight over a row.
 *
 * Every insert/update of a store NOTIFYs `stores_changed`, so the provisioner
 * picks up a new store at once instead of on its next tick.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table mcp_servers add column managed_by text
      check (managed_by in ('store', 'hosted'));

    create table stores (
      id          uuid primary key default gen_random_uuid(),
      slug        text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,30}$'),
      name        text not null check (length(name) between 1 and 100),
      owner_id    uuid references users (id) on delete set null,
      kind        text not null default 'provisioned' check (kind in ('default', 'provisioned')),
      status      text not null default 'provisioning'
                  check (status in ('provisioning', 'ready', 'failed', 'deleting')),
      step        text,
      reason      text,
      namespace   text,
      url         text,
      server_id   uuid references mcp_servers (id) on delete set null,
      deadline_at timestamptz,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    );
    create index stores_owner_idx on stores (owner_id);
    create index stores_pending_idx on stores (status) where status in ('provisioning', 'deleting');
    -- One default store at most.
    create unique index stores_one_default_idx on stores (kind) where kind = 'default';

    create function stores_notify() returns trigger language plpgsql as $$
    begin
      perform pg_notify('stores_changed', new.id::text);
      return new;
    end $$;
    create trigger stores_notify after insert or update on stores
      for each row execute function stores_notify();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table stores;
    drop function stores_notify();
    alter table mcp_servers drop column managed_by;
  `.execute(db);
}
