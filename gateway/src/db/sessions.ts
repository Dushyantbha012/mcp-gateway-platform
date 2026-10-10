import { sql } from "kysely";
import { generateToken } from "../crypto/tokens.js";
import type { Principal } from "./apiKeys.js";
import type { Db } from "./db.js";

/**
 * Starts a dashboard session. Returns the plaintext token (for the cookie)
 * once; only its hash is stored. The user's expired sessions are cleared
 * on the way, so the table doesn't grow without bound.
 */
export async function createSession(
  db: Db,
  userId: string,
  ttlMs: number,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .deleteFrom("sessions")
    .where("user_id", "=", userId)
    .where("expires_at", "<=", sql<Date>`now()`)
    .execute();
  const row = await db
    .insertInto("sessions")
    .values({ user_id: userId, token_hash: hash, expires_at: expiresAt })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt };
}

/**
 * Resolves a session token hash to its user. No cache, same as API keys: a
 * logged-out session, an expired one, or a disabled user is rejected on the
 * very next request.
 */
export async function findPrincipalBySessionHash(
  db: Db,
  hash: Buffer,
): Promise<Principal | undefined> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select(["s.id as sessionId", "u.id as userId", "u.email", "u.role"])
    .where("s.token_hash", "=", hash)
    .where("s.expires_at", ">", sql<Date>`now()`)
    .where("u.disabled_at", "is", null)
    .executeTakeFirst();
  return row && { ...row, authMethod: "session", keyId: null };
}

/** At most one write a minute per session, like touchApiKey. */
export async function touchSession(db: Db, id: string): Promise<void> {
  await db
    .updateTable("sessions")
    .set({ last_seen_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("last_seen_at", "<", sql<Date>`now() - interval '1 minute'`)
    .execute();
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.deleteFrom("sessions").where("id", "=", id).execute();
}

/** Logs a user out everywhere, optionally keeping the session making the request. */
export async function deleteUserSessions(
  db: Db,
  userId: string,
  opts: { except?: string } = {},
): Promise<number> {
  let query = db.deleteFrom("sessions").where("user_id", "=", userId);
  if (opts.except) query = query.where("id", "<>", opts.except);
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}
