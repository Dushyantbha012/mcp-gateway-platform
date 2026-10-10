import { sql } from "kysely";
import type { Db } from "./db.js";
import type { Role, User } from "./schema.js";

export function listUsers(db: Db): Promise<User[]> {
  return db.selectFrom("users").selectAll().orderBy("created_at").execute();
}

export function getUser(db: Db, id: string): Promise<User | undefined> {
  return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
}

export function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  return db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email.toLowerCase())
    .executeTakeFirst();
}

export function createUser(
  db: Db,
  user: { email: string; name: string; role: Role },
): Promise<User> {
  return db
    .insertInto("users")
    .values({ ...user, email: user.email.toLowerCase() })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface UserChanges {
  name?: string;
  role?: Role;
  disabled?: boolean;
}

/**
 * True if applying `changes` to `user` would leave no enabled admin.
 * `otherActiveAdmins` counts enabled admins other than this user.
 */
export function removesLastAdmin(
  user: Pick<User, "role" | "disabled_at">,
  changes: UserChanges,
  otherActiveAdmins: number,
): boolean {
  const activeAdminNow = user.role === "admin" && user.disabled_at === null;
  const role = changes.role ?? user.role;
  const disabled = changes.disabled ?? user.disabled_at !== null;
  const activeAdminAfter = role === "admin" && !disabled;
  return activeAdminNow && !activeAdminAfter && otherActiveAdmins === 0;
}

export class LastAdminError extends Error {
  constructor() {
    super("At least one enabled admin must remain");
  }
}

/**
 * Edits a user, refusing to remove the last enabled admin. The admins' rows
 * are locked (FOR UPDATE) first, so two admins demoting each other at the
 * same moment are serialised and the second one sees the first's change.
 * Disabling a user also ends their dashboard sessions; their API keys stop
 * working through the disabled_at check on every request.
 */
export async function updateUser(
  db: Db,
  id: string,
  changes: UserChanges,
): Promise<User | undefined> {
  return db.transaction().execute(async (tx) => {
    const admins = await tx
      .selectFrom("users")
      .select("id")
      .where("role", "=", "admin")
      .where("disabled_at", "is", null)
      .forUpdate()
      .execute();
    const user = await tx
      .selectFrom("users")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!user) return undefined;
    const others = admins.filter((a) => a.id !== id).length;
    if (removesLastAdmin(user, changes, others)) throw new LastAdminError();

    const disabledAt =
      changes.disabled === undefined
        ? undefined
        : changes.disabled
          ? (user.disabled_at ?? sql<Date>`now()`)
          : null;
    const updated = await tx
      .updateTable("users")
      .set({ name: changes.name, role: changes.role, disabled_at: disabledAt })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (changes.disabled) await tx.deleteFrom("sessions").where("user_id", "=", id).execute();
    return updated;
  });
}

export async function setPasswordHash(db: Db, id: string, hash: string | null): Promise<void> {
  await db.updateTable("users").set({ password_hash: hash }).where("id", "=", id).execute();
}
