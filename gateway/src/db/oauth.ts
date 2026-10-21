import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  newAccessToken,
  newAuthorizationCode,
  newClientId,
  newRefreshToken,
  type Scope,
} from "../crypto/oauth.js";
import type { Principal } from "./apiKeys.js";
import type { Db } from "./db.js";
import type { OAuthClient } from "./schema.js";

/**
 * Storage for the gateway's OAuth server. Codes and tokens are looked up by
 * SHA-256 hash only. Redeeming a code and rotating a refresh token lock the
 * row, so two concurrent uses of the same one can't both succeed.
 */

export function registerClient(
  db: Db,
  client: { name: string; redirectUris: string[] },
): Promise<OAuthClient> {
  return db
    .insertInto("oauth_clients")
    .values({ id: newClientId(), name: client.name, redirect_uris: client.redirectUris })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function getClient(db: Db, id: string): Promise<OAuthClient | undefined> {
  return db.selectFrom("oauth_clients").selectAll().where("id", "=", id).executeTakeFirst();
}

export interface PendingRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: Scope[];
  resource: string;
}

/** An /authorize request waiting for consent. Expired ones are cleared on the way. */
export async function createRequest(db: Db, req: PendingRequest, ttlMs: number): Promise<string> {
  await db
    .deleteFrom("oauth_requests")
    .where("expires_at", "<=", sql<Date>`now()`)
    .execute();
  const row = await db
    .insertInto("oauth_requests")
    .values({
      client_id: req.clientId,
      redirect_uri: req.redirectUri,
      state: req.state,
      code_challenge: req.codeChallenge,
      scope: req.scope,
      resource: req.resource,
      expires_at: new Date(Date.now() + ttlMs),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function getRequest(db: Db, id: string) {
  return db
    .selectFrom("oauth_requests as r")
    .innerJoin("oauth_clients as c", "c.id", "r.client_id")
    .select([
      "r.id",
      "r.client_id",
      "c.name as client_name",
      "r.redirect_uri",
      "r.state",
      "r.code_challenge",
      "r.scope",
      "r.resource",
      "r.expires_at",
    ])
    .where("r.id", "=", id)
    .where("r.expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
}

/** Consumes a pending request: true for exactly one caller. */
export async function takeRequest(db: Db, id: string): Promise<boolean> {
  const res = await db.deleteFrom("oauth_requests").where("id", "=", id).executeTakeFirst();
  return Number(res.numDeletedRows) === 1;
}

/** A single-use code for the consent the user just gave; it starts a new token family. */
export async function issueCode(
  db: Db,
  grant: PendingRequest & { userId: string },
  ttlMs: number,
): Promise<string> {
  const code = newAuthorizationCode();
  await db
    .insertInto("oauth_codes")
    .values({
      hash: code.hash,
      client_id: grant.clientId,
      user_id: grant.userId,
      redirect_uri: grant.redirectUri,
      code_challenge: grant.codeChallenge,
      scope: grant.scope,
      resource: grant.resource,
      family_id: randomUUID(),
      expires_at: new Date(Date.now() + ttlMs),
    })
    .execute();
  return code.value;
}

export interface Grant {
  familyId: string;
  clientId: string;
  userId: string;
  scope: string[];
  resource: string;
}

export type Redeemed =
  | { kind: "ok"; grant: Grant; redirectUri: string; codeChallenge: string }
  | { kind: "invalid" }
  /** Used before: whatever it was exchanged for is revoked now (RFC 6749 section 4.1.2). */
  | { kind: "replayed" };

export function redeemCode(db: Db, hash: Buffer): Promise<Redeemed> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("oauth_codes as c")
      .innerJoin("users as u", "u.id", "c.user_id")
      .select([
        "c.hash",
        "c.client_id",
        "c.user_id",
        "c.redirect_uri",
        "c.code_challenge",
        "c.scope",
        "c.resource",
        "c.family_id",
        "c.expires_at",
        "c.used_at",
        "u.disabled_at",
      ])
      .where("c.hash", "=", hash)
      .forUpdate("c")
      .executeTakeFirst();
    if (!row) return { kind: "invalid" };
    if (row.used_at) {
      await revokeFamily(trx, row.family_id);
      return { kind: "replayed" };
    }
    if (row.expires_at <= new Date() || row.disabled_at) return { kind: "invalid" };
    await trx
      .updateTable("oauth_codes")
      .set({ used_at: sql<Date>`now()` })
      .where("hash", "=", hash)
      .execute();
    return {
      kind: "ok",
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      grant: {
        familyId: row.family_id,
        clientId: row.client_id,
        userId: row.user_id,
        scope: row.scope,
        resource: row.resource,
      },
    };
  });
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string[];
}

export async function issueTokens(
  db: Db,
  grant: Grant,
  ttl: { accessMs: number; refreshMs: number },
  /** A refresh may ask for less (RFC 6749 section 6); the refresh token keeps the whole grant. */
  accessScope: string[] = grant.scope,
): Promise<IssuedTokens> {
  const access = newAccessToken();
  const refresh = newRefreshToken();
  const now = Date.now();
  const common = {
    family_id: grant.familyId,
    client_id: grant.clientId,
    user_id: grant.userId,
    scope: grant.scope,
    resource: grant.resource,
  };
  await db
    .insertInto("oauth_tokens")
    .values([
      {
        ...common,
        scope: accessScope,
        hash: access.hash,
        kind: "access",
        expires_at: new Date(now + ttl.accessMs),
      },
      {
        ...common,
        hash: refresh.hash,
        kind: "refresh",
        expires_at: new Date(now + ttl.refreshMs),
      },
    ])
    .execute();
  await db
    .updateTable("oauth_clients")
    .set({ last_used_at: sql<Date>`now()` })
    .where("id", "=", grant.clientId)
    .execute();
  return {
    accessToken: access.value,
    refreshToken: refresh.value,
    expiresIn: Math.floor(ttl.accessMs / 1000),
    scope: accessScope,
  };
}

export type Rotated = { kind: "ok"; grant: Grant } | { kind: "invalid" } | { kind: "replayed" };

/**
 * Uses a refresh token up. The caller issues the next pair in the same
 * family. Using one twice means two parties hold it - one is a thief - so
 * the whole family is revoked and both have to sign in again.
 */
export function useRefreshToken(db: Db, hash: Buffer, clientId: string): Promise<Rotated> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("oauth_tokens as t")
      .innerJoin("users as u", "u.id", "t.user_id")
      .select([
        "t.id",
        "t.family_id",
        "t.client_id",
        "t.user_id",
        "t.scope",
        "t.resource",
        "t.expires_at",
        "t.used_at",
        "t.revoked_at",
        "u.disabled_at",
      ])
      .where("t.hash", "=", hash)
      .where("t.kind", "=", "refresh")
      .forUpdate("t")
      .executeTakeFirst();
    if (!row || row.client_id !== clientId) return { kind: "invalid" };
    if (row.revoked_at) return { kind: "invalid" };
    if (row.used_at) {
      await revokeFamily(trx, row.family_id);
      return { kind: "replayed" };
    }
    if (row.expires_at <= new Date() || row.disabled_at) return { kind: "invalid" };
    await trx
      .updateTable("oauth_tokens")
      .set({ used_at: sql<Date>`now()` })
      .where("id", "=", row.id)
      .execute();
    return {
      kind: "ok",
      grant: {
        familyId: row.family_id,
        clientId: row.client_id,
        userId: row.user_id,
        scope: row.scope,
        resource: row.resource,
      },
    };
  });
}

export async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db
    .updateTable("oauth_tokens")
    .set({ revoked_at: sql<Date>`now()` })
    .where("family_id", "=", familyId)
    .where("revoked_at", "is", null)
    .execute();
}

/** RFC 7009: revoking either token of a grant ends the grant. Unknown tokens are not an error. */
export async function revokeByTokenHash(db: Db, hash: Buffer): Promise<void> {
  const row = await db
    .selectFrom("oauth_tokens")
    .select("family_id")
    .where("hash", "=", hash)
    .executeTakeFirst();
  if (row) await revokeFamily(db, row.family_id);
}

/**
 * Resolves an access token to its user, for /mcp. No cache, like API keys: a
 * revoked grant or a disabled user is rejected on the very next request.
 */
export async function findPrincipalByAccessHash(
  db: Db,
  hash: Buffer,
): Promise<(Principal & { resource: string }) | undefined> {
  const row = await db
    .selectFrom("oauth_tokens as t")
    .innerJoin("users as u", "u.id", "t.user_id")
    .select([
      "t.id as tokenId",
      "t.client_id as clientId",
      "t.scope",
      "t.resource",
      "u.id as userId",
      "u.email",
      "u.role",
    ])
    .where("t.hash", "=", hash)
    .where("t.kind", "=", "access")
    .where("t.revoked_at", "is", null)
    .where("t.expires_at", ">", sql<Date>`now()`)
    .where("u.disabled_at", "is", null)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    userId: row.userId,
    email: row.email,
    role: row.role,
    authMethod: "oauth",
    keyId: null,
    sessionId: null,
    oauth: { tokenId: row.tokenId, clientId: row.clientId, scopes: row.scope },
    resource: row.resource,
  };
}

/** At most one write a minute per token, like touchApiKey. */
export async function touchAccessToken(db: Db, tokenId: string): Promise<void> {
  await db
    .updateTable("oauth_tokens")
    .set({ last_used_at: sql<Date>`now()` })
    .where("id", "=", tokenId)
    .where((eb) =>
      eb.or([
        eb("last_used_at", "is", null),
        eb("last_used_at", "<", sql<Date>`now() - interval '1 minute'`),
      ]),
    )
    .execute();
}

export interface ConnectedApp {
  familyId: string;
  clientId: string;
  clientName: string;
  scope: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The user's live grants (a refresh token still usable), newest first. */
export async function listConnectedApps(db: Db, userId: string): Promise<ConnectedApp[]> {
  const rows = await db
    .selectFrom("oauth_tokens as t")
    .innerJoin("oauth_clients as c", "c.id", "t.client_id")
    .select([
      "t.family_id as familyId",
      "t.client_id as clientId",
      "c.name as clientName",
      // The grant's scope is its refresh tokens' (fixed at consent); an access
      // token from a narrowing refresh may carry less.
      sql<
        string[]
      >`(array_agg(array_to_string(t.scope, ' ')) filter (where t.kind = 'refresh'))[1]`.as(
        "scope",
      ),
      sql<Date>`min(t.created_at)`.as("createdAt"),
      sql<Date | null>`max(t.last_used_at)`.as("lastUsedAt"),
    ])
    .where("t.user_id", "=", userId)
    .groupBy(["t.family_id", "t.client_id", "c.name"])
    .having(
      sql<boolean>`bool_or(t.kind = 'refresh' and t.used_at is null and t.revoked_at is null and t.expires_at > now())`,
    )
    .orderBy("createdAt", "desc")
    .execute();
  return rows.map((r) => ({ ...r, scope: (r.scope as unknown as string).split(" ") }));
}

/** Revoke one of the user's grants; false if it isn't theirs (or doesn't exist). */
export async function revokeUserGrant(db: Db, userId: string, familyId: string): Promise<boolean> {
  const res = await db
    .updateTable("oauth_tokens")
    .set({ revoked_at: sql<Date>`now()` })
    .where("family_id", "=", familyId)
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}
