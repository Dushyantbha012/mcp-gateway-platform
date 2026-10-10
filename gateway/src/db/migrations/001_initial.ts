import { sql, type Kysely } from "kysely";

/**
 * Initial schema. Plain SQL on purpose: every constraint here is something
 * the gateway relies on (unique key hash, slug format, allowed enum values),
 * so it should read exactly as Postgres will enforce it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table users (
      id          uuid primary key default gen_random_uuid(),
      email       text not null check (email = lower(email) and email like '%_@_%'),
      name        text not null,
      role        text not null check (role in ('admin', 'member')),
      created_at  timestamptz not null default now(),
      disabled_at timestamptz
    );
    create unique index users_email_key on users (email);

    create table api_keys (
      id           uuid primary key default gen_random_uuid(),
      user_id      uuid not null references users (id) on delete cascade,
      name         text not null,
      prefix       text not null,
      key_hash     bytea not null unique check (octet_length(key_hash) = 32),
      created_at   timestamptz not null default now(),
      last_used_at timestamptz,
      revoked_at   timestamptz
    );
    create index api_keys_user_id_idx on api_keys (user_id);

    create table mcp_servers (
      id                    uuid primary key default gen_random_uuid(),
      slug                  text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,30}$'),
      name                  text not null,
      url                   text not null check (url ~ '^https?://'),
      enabled               boolean not null default true,
      auth_type             text not null default 'none' check (auth_type in ('none', 'bearer', 'header')),
      auth_header_name      text,
      credential_ciphertext bytea,
      timeout_ms            integer not null default 10000 check (timeout_ms between 100 and 120000),
      status                text not null default 'unknown' check (status in ('connected', 'unreachable', 'unknown')),
      last_error            text,
      last_checked_at       timestamptz,
      tools_cache           jsonb,
      tools_cached_at       timestamptz,
      created_at            timestamptz not null default now(),
      updated_at            timestamptz not null default now(),
      check (auth_type <> 'header' or auth_header_name is not null),
      check (auth_type = 'none' or credential_ciphertext is not null)
    );

    -- user_email and server_slug are copied, not just referenced, so the log
    -- still says who called what after a user or server is deleted.
    create table audit_log (
      id          bigserial primary key,
      ts          timestamptz not null default now(),
      user_id     uuid references users (id) on delete set null,
      user_email  text not null,
      api_key_id  uuid references api_keys (id) on delete set null,
      source      text not null check (source in ('mcp', 'chat')),
      server_slug text,
      tool_name   text not null,
      duration_ms integer not null,
      outcome     text not null check (outcome in ('success', 'tool_error', 'timeout', 'unreachable', 'rejected')),
      error       text
    );
    create index audit_log_ts_idx on audit_log (ts desc);
    create index audit_log_user_ts_idx on audit_log (user_id, ts desc);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table audit_log, mcp_servers, api_keys, users`.execute(db);
}
