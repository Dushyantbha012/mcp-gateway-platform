import { sql, type Kysely } from "kysely";

/**
 * Tool permissions: allow/deny rules for a role or a single user, over a whole
 * server or one tool. Plus a 'denied' audit outcome, so the log shows who
 * tried something they weren't allowed to (distinct from 'rejected', which
 * means the tool is unknown or its server is disabled).
 *
 * server_slug / tool_name are plain text, not foreign keys: tool names belong
 * to upstreams and a rule may name a tool before it exists. Removing a server
 * deletes its rules in the API, so a new server reusing the slug starts clean.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table tool_permissions (
      id          uuid primary key default gen_random_uuid(),
      role        text check (role in ('admin', 'member')),
      user_id     uuid references users (id) on delete cascade,
      server_slug text not null check (server_slug ~ '^[a-z][a-z0-9-]{1,30}$'),
      tool_name   text check (tool_name is null or (length(tool_name) between 1 and 200)),
      effect      text not null check (effect in ('allow', 'deny')),
      created_by  uuid references users (id) on delete set null,
      created_at  timestamptz not null default now(),
      -- Exactly one kind of subject.
      check ((role is null) <> (user_id is null))
    );
    -- One rule per subject and target: setting it again replaces it.
    create unique index tool_permissions_target_idx on tool_permissions (
      coalesce(role, ''),
      coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
      server_slug,
      coalesce(tool_name, '')
    );
    create index tool_permissions_server_idx on tool_permissions (server_slug);

    alter table audit_log drop constraint audit_log_outcome_check;
    alter table audit_log add constraint audit_log_outcome_check
      check (outcome in ('success', 'tool_error', 'timeout', 'unreachable', 'rejected', 'denied'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from audit_log where outcome = 'denied';
    alter table audit_log drop constraint audit_log_outcome_check;
    alter table audit_log add constraint audit_log_outcome_check
      check (outcome in ('success', 'tool_error', 'timeout', 'unreachable', 'rejected'));
    drop table tool_permissions;
  `.execute(db);
}
