import { sql } from "kysely";
import { generateToken } from "../crypto/tokens.js";
import type { Db } from "./db.js";
import type { User } from "./schema.js";

/**
 * Issues a one-time invite link token for a user. Any earlier unused invite
 * for them is voided, so only the newest link works. Returns the plaintext
 * token once; only its hash is stored.
 */
export async function createInvite(
  db: Db,
  invite: { userId: string; createdBy: string | null; ttlMs: number },
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + invite.ttlMs);
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("invites")
      .where("user_id", "=", invite.userId)
      .where("used_at", "is", null)
      .execute();
    await tx
      .insertInto("invites")
      .values({
        user_id: invite.userId,
        token_hash: hash,
        created_by: invite.createdBy,
        expires_at: expiresAt,
      })
      .execute();
  });
  return { token, expiresAt };
}

/** An unused, unexpired invite for an enabled user. */
export async function findValidInvite(
  db: Db,
  hash: Buffer,
): Promise<{ inviteId: string; user: User } | undefined> {
  const invite = await db
    .selectFrom("invites")
    .select(["id", "user_id"])
    .where("token_hash", "=", hash)
    .where("used_at", "is", null)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  if (!invite) return undefined;
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", invite.user_id)
    .where("disabled_at", "is", null)
    .executeTakeFirst();
  return user && { inviteId: invite.id, user };
}

/**
 * Accepts an invite: sets the password and logs the user out everywhere
 * else, in one transaction. The conditional update on used_at makes it
 * single-use even if the link is submitted twice at the same moment - the
 * second attempt updates no row and gets `false`.
 */
export async function acceptInvite(
  db: Db,
  inviteId: string,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const used = await tx
      .updateTable("invites")
      .set({ used_at: sql<Date>`now()` })
      .where("id", "=", inviteId)
      .where("used_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (used.numUpdatedRows === 0n) return false;
    await tx
      .updateTable("users")
      .set({ password_hash: passwordHash })
      .where("id", "=", userId)
      .execute();
    await tx.deleteFrom("sessions").where("user_id", "=", userId).execute();
    return true;
  });
}
