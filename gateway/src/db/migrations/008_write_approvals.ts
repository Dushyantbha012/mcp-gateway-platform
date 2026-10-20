import { sql, type Kysely } from "kysely";

/**
 * Approvals for write tools called over MCP. The first call of a write creates a
 * pending row and is refused; the user approves it in the dashboard (a session,
 * which an API key can't have), and the client's retry then runs it once.
 *
 * `args_hash` ties an approval to the exact arguments it was shown, so a client
 * can't get "create a product called X" approved and then run something else.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table write_approvals (
      id          uuid primary key default gen_random_uuid(),
      user_id     uuid not null references users (id) on delete cascade,
      tool_name   text not null check (length(tool_name) between 1 and 200),
      args        jsonb not null,
      args_hash   text not null,
      status      text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
      created_at  timestamptz not null default now(),
      decided_at  timestamptz,
      expires_at  timestamptz not null,
      used_at     timestamptz
    );
    create index write_approvals_lookup_idx on write_approvals (user_id, tool_name, args_hash);
    create index write_approvals_pending_idx on write_approvals (user_id, status);

    -- 'held': a write that is waiting for (or was refused for lack of) an approval.
    alter table audit_log drop constraint audit_log_outcome_check;
    alter table audit_log add constraint audit_log_outcome_check
      check (outcome in ('success', 'tool_error', 'timeout', 'unreachable', 'rejected', 'denied', 'held'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from audit_log where outcome = 'held';
    alter table audit_log drop constraint audit_log_outcome_check;
    alter table audit_log add constraint audit_log_outcome_check
      check (outcome in ('success', 'tool_error', 'timeout', 'unreachable', 'rejected', 'denied'));
    drop table write_approvals;
  `.execute(db);
}
