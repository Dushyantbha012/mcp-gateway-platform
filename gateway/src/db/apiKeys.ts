import { sql } from "kysely";
import type { Db } from "./db.js";
import type { ApiKey, Role } from "./schema.js";

/** Everything a request needs to know about who is calling. */
export interface Principal {
  userId: string;
  email: string;
  role: Role;
  keyId: string;
}

/** Key metadata safe to return to clients: never the hash. */
export type ApiKeyInfo = Omit<ApiKey, "key_hash">;

const infoColumns = [
  "id",
  "user_id",
  "name",
  "prefix",
  "created_at",
  "last_used_at",
  "revoked_at",
] as const;

export function insertApiKey(
  db: Db,
  key: { userId: string; name: string; prefix: string; hash: Buffer },
): Promise<ApiKeyInfo> {
  return db
    .insertInto("api_keys")
    .values({ user_id: key.userId, name: key.name, prefix: key.prefix, key_hash: key.hash })
    .returning(infoColumns)
    .executeTakeFirstOrThrow();
}

/**
 * Resolves a key hash to its owner. No caching on purpose: a revoked key or a
 * disabled user is rejected on the very next request.
 */
export async function findPrincipalByKeyHash(db: Db, hash: Buffer): Promise<Principal | undefined> {
  const row = await db
    .selectFrom("api_keys as k")
    .innerJoin("users as u", "u.id", "k.user_id")
    .select(["k.id as keyId", "u.id as userId", "u.email", "u.role"])
    .where("k.key_hash", "=", hash)
    .where("k.revoked_at", "is", null)
    .where("u.disabled_at", "is", null)
    .executeTakeFirst();
  return row;
}

/** Records use at most once a minute per key, so calls don't each cost a write. */
export async function touchApiKey(db: Db, keyId: string): Promise<void> {
  await db
    .updateTable("api_keys")
    .set({ last_used_at: sql<Date>`now()` })
    .where("id", "=", keyId)
    .where((eb) =>
      eb.or([
        eb("last_used_at", "is", null),
        eb("last_used_at", "<", sql<Date>`now() - interval '1 minute'`),
      ]),
    )
    .execute();
}

export function listApiKeys(db: Db, userId: string): Promise<ApiKeyInfo[]> {
  return db
    .selectFrom("api_keys")
    .select(infoColumns)
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
}

export function getApiKey(db: Db, id: string): Promise<ApiKeyInfo | undefined> {
  return db.selectFrom("api_keys").select(infoColumns).where("id", "=", id).executeTakeFirst();
}

/** Idempotent: revoking an already-revoked key keeps the original timestamp. */
export async function revokeApiKey(db: Db, id: string): Promise<ApiKeyInfo | undefined> {
  await db
    .updateTable("api_keys")
    .set({ revoked_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("revoked_at", "is", null)
    .execute();
  return getApiKey(db, id);
}
