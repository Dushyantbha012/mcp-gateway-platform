import type { PermissionRule } from "../permissions/evaluate.js";
import type { Db } from "./db.js";
import type { Role, ToolPermissionRow } from "./schema.js";

export interface RuleInput {
  /** Exactly one of role / userId. */
  role?: Role;
  userId?: string;
  serverSlug: string;
  toolName: string | null;
  effect: "allow" | "deny";
  createdBy: string | null;
}

export const toRule = (row: ToolPermissionRow): PermissionRule =>
  row.user_id
    ? {
        subjectType: "user",
        subject: row.user_id,
        serverSlug: row.server_slug,
        toolName: row.tool_name,
        effect: row.effect,
      }
    : {
        subjectType: "role",
        subject: row.role as string,
        serverSlug: row.server_slug,
        toolName: row.tool_name,
        effect: row.effect,
      };

export function listPermissionRows(db: Db): Promise<ToolPermissionRow[]> {
  return db
    .selectFrom("tool_permissions")
    .selectAll()
    .orderBy("server_slug")
    .orderBy("created_at")
    .execute();
}

/**
 * Only the rules that can apply to this user (their role's and their own).
 * Read on every list and call, never cached: a rule change applies on the
 * caller's very next request, on every replica.
 */
export async function rulesFor(
  db: Db,
  subject: { userId: string; role: Role },
): Promise<PermissionRule[]> {
  const rows = await db
    .selectFrom("tool_permissions")
    .selectAll()
    .where((eb) => eb.or([eb("role", "=", subject.role), eb("user_id", "=", subject.userId)]))
    .execute();
  return rows.map(toRule);
}

/** Creates the rule, or changes the effect of the existing one for the same subject and target. */
export async function upsertRule(db: Db, input: RuleInput): Promise<ToolPermissionRow> {
  const existing = await db
    .selectFrom("tool_permissions")
    .select("id")
    .where("server_slug", "=", input.serverSlug)
    .where((eb) =>
      input.toolName === null ? eb("tool_name", "is", null) : eb("tool_name", "=", input.toolName),
    )
    .where((eb) =>
      input.userId ? eb("user_id", "=", input.userId) : eb("role", "=", input.role ?? null),
    )
    .executeTakeFirst();
  if (existing) {
    return db
      .updateTable("tool_permissions")
      .set({ effect: input.effect, created_by: input.createdBy })
      .where("id", "=", existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return db
    .insertInto("tool_permissions")
    .values({
      role: input.userId ? null : (input.role ?? null),
      user_id: input.userId ?? null,
      server_slug: input.serverSlug,
      tool_name: input.toolName,
      effect: input.effect,
      created_by: input.createdBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteRule(db: Db, id: string): Promise<boolean> {
  const r = await db.deleteFrom("tool_permissions").where("id", "=", id).executeTakeFirst();
  return r.numDeletedRows > 0n;
}

export async function deleteRulesForServer(db: Db, serverSlug: string): Promise<void> {
  await db.deleteFrom("tool_permissions").where("server_slug", "=", serverSlug).execute();
}

/** A server's slug changed: its rules follow it. */
export async function renameServerRules(db: Db, from: string, to: string): Promise<void> {
  await db
    .updateTable("tool_permissions")
    .set({ server_slug: to })
    .where("server_slug", "=", from)
    .execute();
}
