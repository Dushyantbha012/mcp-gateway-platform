import { sql, type Kysely } from "kysely";

/**
 * OAuth 2.1 for MCP clients: the gateway is its own authorization server.
 *
 * - oauth_clients: registered with dynamic client registration (RFC 7591).
 *   Public clients only (PKCE, no secret), so nothing secret is stored.
 * - oauth_requests: an /authorize request waiting for the user's consent in
 *   the dashboard. Short-lived.
 * - oauth_codes: single-use authorization codes, as SHA-256 hashes.
 * - oauth_tokens: access and refresh tokens, as SHA-256 hashes. Every token
 *   issued from one consent shares a family; replaying a used refresh token
 *   or code revokes the whole family.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table oauth_clients (
      id            text primary key check (id ~ '^mgc_[A-Za-z0-9_-]{22}$'),
      name          text not null check (length(name) between 1 and 200),
      redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
      created_at    timestamptz not null default now(),
      last_used_at  timestamptz
    );

    create table oauth_requests (
      id             uuid primary key default gen_random_uuid(),
      client_id      text not null references oauth_clients (id) on delete cascade,
      redirect_uri   text not null,
      state          text,
      code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
      scope          text[] not null,
      resource       text not null,
      created_at     timestamptz not null default now(),
      expires_at     timestamptz not null
    );

    create table oauth_codes (
      hash           bytea primary key check (octet_length(hash) = 32),
      client_id      text not null references oauth_clients (id) on delete cascade,
      user_id        uuid not null references users (id) on delete cascade,
      redirect_uri   text not null,
      code_challenge text not null,
      scope          text[] not null,
      resource       text not null,
      family_id      uuid not null,
      created_at     timestamptz not null default now(),
      expires_at     timestamptz not null,
      used_at        timestamptz
    );

    create table oauth_tokens (
      id           uuid primary key default gen_random_uuid(),
      hash         bytea not null unique check (octet_length(hash) = 32),
      kind         text not null check (kind in ('access', 'refresh')),
      family_id    uuid not null,
      client_id    text not null references oauth_clients (id) on delete cascade,
      user_id      uuid not null references users (id) on delete cascade,
      scope        text[] not null,
      resource     text not null,
      created_at   timestamptz not null default now(),
      expires_at   timestamptz not null,
      -- A refresh token is used once; using it again is theft (or a bug) - revoke the family.
      used_at      timestamptz,
      last_used_at timestamptz,
      revoked_at   timestamptz
    );
    create index oauth_tokens_family_idx on oauth_tokens (family_id);
    create index oauth_tokens_user_idx on oauth_tokens (user_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table oauth_tokens, oauth_codes, oauth_requests, oauth_clients`.execute(db);
}
