import { sql, type Kysely } from "kysely";

/**
 * Dashboard login: a password per user, browser sessions, and one-time
 * invite links. Session and invite tokens are stored only as SHA-256 hashes,
 * like API keys: a database leak doesn't hand out live logins.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Null until the user accepts an invite (or the bootstrap admin is seeded).
    alter table users add column password_hash text;

    create table sessions (
      id           uuid primary key default gen_random_uuid(),
      user_id      uuid not null references users (id) on delete cascade,
      token_hash   bytea not null unique check (octet_length(token_hash) = 32),
      created_at   timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at   timestamptz not null
    );
    create index sessions_user_id_idx on sessions (user_id);

    create table invites (
      id         uuid primary key default gen_random_uuid(),
      user_id    uuid not null references users (id) on delete cascade,
      token_hash bytea not null unique check (octet_length(token_hash) = 32),
      created_by uuid references users (id) on delete set null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at    timestamptz
    );
    create index invites_user_id_idx on invites (user_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table invites, sessions;
    alter table users drop column password_hash;
  `.execute(db);
}
