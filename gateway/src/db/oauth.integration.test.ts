import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../crypto/oauth.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import {
  createRequest,
  findPrincipalByAccessHash,
  getClient,
  getRequest,
  issueCode,
  issueTokens,
  listConnectedApps,
  redeemCode,
  registerClient,
  revokeByTokenHash,
  revokeUserGrant,
  takeRequest,
  touchAccessToken,
  useRefreshToken,
  type Grant,
} from "./oauth.js";
import { createUser, updateUser } from "./users.js";

const MIN = 60_000;
const TTL = { accessMs: 60 * MIN, refreshMs: 30 * 24 * 60 * MIN };
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const RESOURCE = "https://gw.example.com/mcp";

describe.skipIf(!hasTestDb)("oauth storage", () => {
  let t: TestDatabase;
  let n = 0;
  const user = () =>
    createUser(t.db, { email: `o${++n}@example.com`, name: `O${n}`, role: "member" });
  const client = () =>
    registerClient(t.db, { name: "Claude Code", redirectUris: ["http://127.0.0.1:1/callback"] });

  /** register -> consent -> code, the way the endpoints will. */
  async function consented(scope: ("mcp:read" | "mcp:write")[] = ["mcp:read", "mcp:write"]) {
    const [u, c] = await Promise.all([user(), client()]);
    const code = await issueCode(
      t.db,
      {
        clientId: c.id,
        userId: u.id,
        redirectUri: "http://127.0.0.1:5000/callback",
        state: "s",
        codeChallenge: CHALLENGE,
        scope,
        resource: RESOURCE,
      },
      10 * MIN,
    );
    return { u, c, code };
  }
  async function tokens() {
    const { u, c, code } = await consented();
    const r = await redeemCode(t.db, sha256(code));
    if (r.kind !== "ok") throw new Error(r.kind);
    return { u, c, grant: r.grant, issued: await issueTokens(t.db, r.grant, TTL) };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("registers clients with a generated id", async () => {
    const c = await client();
    expect(c.id).toMatch(/^mgc_/);
    expect(await getClient(t.db, c.id)).toMatchObject({ name: "Claude Code" });
    expect(await getClient(t.db, "mgc_nope")).toBeUndefined();
  });

  it("keeps a pending request until it's taken once or expires", async () => {
    const c = await client();
    const req = {
      clientId: c.id,
      redirectUri: "http://127.0.0.1:1/callback",
      state: "xyz",
      codeChallenge: CHALLENGE,
      scope: ["mcp:read" as const],
      resource: RESOURCE,
    };
    const id = await createRequest(t.db, req, 10 * MIN);
    expect(await getRequest(t.db, id)).toMatchObject({ client_name: "Claude Code", state: "xyz" });
    expect(await takeRequest(t.db, id)).toBe(true);
    expect(await takeRequest(t.db, id)).toBe(false);
    expect(await getRequest(t.db, id)).toBeUndefined();

    // Well in the past, so a few ms of clock skew with the database don't matter.
    const old = await createRequest(t.db, req, -MIN);
    expect(await getRequest(t.db, old)).toBeUndefined();
    await createRequest(t.db, req, 10 * MIN); // clears expired ones
    const left = await t.db.selectFrom("oauth_requests").select("id").execute();
    expect(left.map((r) => r.id)).not.toContain(old);
  });

  describe("authorization codes", () => {
    it("redeem once, and are stored only as a hash", async () => {
      const { u, c, code } = await consented(["mcp:read"]);
      const rows = await t.db.selectFrom("oauth_codes").selectAll().execute();
      expect(JSON.stringify(rows)).not.toContain(code);

      const r = await redeemCode(t.db, sha256(code));
      expect(r).toMatchObject({
        kind: "ok",
        redirectUri: "http://127.0.0.1:5000/callback",
        codeChallenge: CHALLENGE,
        grant: { clientId: c.id, userId: u.id, scope: ["mcp:read"], resource: RESOURCE },
      });
      expect(await redeemCode(t.db, sha256("unknown"))).toEqual({ kind: "invalid" });
    });

    it("replayed: whatever the first redemption got is revoked", async () => {
      const { code } = await consented();
      const r = await redeemCode(t.db, sha256(code));
      if (r.kind !== "ok") throw new Error(r.kind);
      const issued = await issueTokens(t.db, r.grant, TTL);

      expect(await redeemCode(t.db, sha256(code))).toEqual({ kind: "replayed" });
      expect(await findPrincipalByAccessHash(t.db, sha256(issued.accessToken))).toBeUndefined();
      expect(await useRefreshToken(t.db, sha256(issued.refreshToken), r.grant.clientId)).toEqual({
        kind: "invalid",
      });
    });

    it("concurrent redemptions: exactly one wins", async () => {
      const { code } = await consented();
      const results = await Promise.all([
        redeemCode(t.db, sha256(code)),
        redeemCode(t.db, sha256(code)),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["ok", "replayed"]);
    });

    it("expired, or the user disabled since consent: invalid", async () => {
      const a = await consented();
      await t.db
        .updateTable("oauth_codes")
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where("hash", "=", sha256(a.code))
        .execute();
      expect(await redeemCode(t.db, sha256(a.code))).toEqual({ kind: "invalid" });

      const b = await consented();
      await updateUser(t.db, b.u.id, { disabled: true });
      expect(await redeemCode(t.db, sha256(b.code))).toEqual({ kind: "invalid" });
    });
  });

  describe("access tokens", () => {
    it("resolve to their user with the grant's scope and resource", async () => {
      const { u, c, issued } = await tokens();
      expect(issued.expiresIn).toBe(3600);
      const p = await findPrincipalByAccessHash(t.db, sha256(issued.accessToken));
      expect(p).toMatchObject({
        userId: u.id,
        role: "member",
        authMethod: "oauth",
        keyId: null,
        sessionId: null,
        oauth: { clientId: c.id, scopes: ["mcp:read", "mcp:write"] },
        resource: RESOURCE,
      });
      const rows = await t.db.selectFrom("oauth_tokens").selectAll().execute();
      expect(JSON.stringify(rows)).not.toContain(issued.accessToken);
      expect(JSON.stringify(rows)).not.toContain(issued.refreshToken);
      expect((await getClient(t.db, c.id))?.last_used_at).not.toBeNull();
    });

    it("stop resolving when expired, revoked, or the user is disabled", async () => {
      const a = await tokens();
      await t.db
        .updateTable("oauth_tokens")
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where("hash", "=", sha256(a.issued.accessToken))
        .execute();
      expect(await findPrincipalByAccessHash(t.db, sha256(a.issued.accessToken))).toBeUndefined();

      const b = await tokens();
      await revokeByTokenHash(t.db, sha256(b.issued.refreshToken));
      expect(await findPrincipalByAccessHash(t.db, sha256(b.issued.accessToken))).toBeUndefined();
      await revokeByTokenHash(t.db, sha256("never issued")); // not an error

      const c = await tokens();
      await updateUser(t.db, c.u.id, { disabled: true });
      expect(await findPrincipalByAccessHash(t.db, sha256(c.issued.accessToken))).toBeUndefined();
    });

    it("refresh tokens can't be used as access tokens", async () => {
      const { issued } = await tokens();
      expect(await findPrincipalByAccessHash(t.db, sha256(issued.refreshToken))).toBeUndefined();
    });

    it("record last use at most once a minute", async () => {
      const { issued } = await tokens();
      const p = await findPrincipalByAccessHash(t.db, sha256(issued.accessToken));
      const lastUsed = async () =>
        (
          await t.db
            .selectFrom("oauth_tokens")
            .select("last_used_at")
            .where("id", "=", p!.oauth!.tokenId)
            .executeTakeFirstOrThrow()
        ).last_used_at;
      await touchAccessToken(t.db, p!.oauth!.tokenId);
      const first = await lastUsed();
      expect(first).not.toBeNull();
      await touchAccessToken(t.db, p!.oauth!.tokenId);
      expect(await lastUsed()).toEqual(first);
    });
  });

  describe("refresh tokens", () => {
    it("rotate: each one works once and the next pair joins the family", async () => {
      const { c, grant, issued } = await tokens();
      const r = await useRefreshToken(t.db, sha256(issued.refreshToken), c.id);
      expect(r).toEqual({ kind: "ok", grant });
      const next = await issueTokens(t.db, (r as { grant: Grant }).grant, TTL);
      expect(await findPrincipalByAccessHash(t.db, sha256(next.accessToken))).toBeDefined();
      expect(await useRefreshToken(t.db, sha256(next.refreshToken), c.id)).toMatchObject({
        kind: "ok",
      });
    });

    it("reused: the whole family is revoked, including the thief's new pair", async () => {
      const { c, issued } = await tokens();
      const r = await useRefreshToken(t.db, sha256(issued.refreshToken), c.id);
      if (r.kind !== "ok") throw new Error(r.kind);
      const next = await issueTokens(t.db, r.grant, TTL);

      expect(await useRefreshToken(t.db, sha256(issued.refreshToken), c.id)).toEqual({
        kind: "replayed",
      });
      expect(await findPrincipalByAccessHash(t.db, sha256(next.accessToken))).toBeUndefined();
      expect(await useRefreshToken(t.db, sha256(next.refreshToken), c.id)).toEqual({
        kind: "invalid",
      });
    });

    it("are bound to their client, and refused when expired or the user is disabled", async () => {
      const a = await tokens();
      const other = await client();
      expect(await useRefreshToken(t.db, sha256(a.issued.refreshToken), other.id)).toEqual({
        kind: "invalid",
      });
      // ...and a wrong client doesn't burn the token.
      expect(await useRefreshToken(t.db, sha256(a.issued.refreshToken), a.c.id)).toMatchObject({
        kind: "ok",
      });

      const b = await tokens();
      await t.db
        .updateTable("oauth_tokens")
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where("hash", "=", sha256(b.issued.refreshToken))
        .execute();
      expect(await useRefreshToken(t.db, sha256(b.issued.refreshToken), b.c.id)).toEqual({
        kind: "invalid",
      });

      const d = await tokens();
      await updateUser(t.db, d.u.id, { disabled: true });
      expect(await useRefreshToken(t.db, sha256(d.issued.refreshToken), d.c.id)).toEqual({
        kind: "invalid",
      });
      expect(await useRefreshToken(t.db, sha256(d.issued.accessToken), d.c.id)).toEqual({
        kind: "invalid",
      });
    });

    it("concurrent refreshes with the same token: one wins, the family is revoked", async () => {
      const { c, issued } = await tokens();
      const results = await Promise.all([
        useRefreshToken(t.db, sha256(issued.refreshToken), c.id),
        useRefreshToken(t.db, sha256(issued.refreshToken), c.id),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["ok", "replayed"]);
    });
  });

  describe("connected apps", () => {
    it("lists the user's live grants once each, and the user can revoke only their own", async () => {
      const { u, c, grant, issued } = await tokens();
      // A rotation keeps it one app, not two.
      const r = await useRefreshToken(t.db, sha256(issued.refreshToken), c.id);
      if (r.kind !== "ok") throw new Error(r.kind);
      await issueTokens(t.db, r.grant, TTL);

      const apps = await listConnectedApps(t.db, u.id);
      expect(apps).toHaveLength(1);
      expect(apps[0]).toMatchObject({
        familyId: grant.familyId,
        clientId: c.id,
        clientName: "Claude Code",
        scope: ["mcp:read", "mcp:write"],
      });

      const stranger = await user();
      expect(await listConnectedApps(t.db, stranger.id)).toEqual([]);
      expect(await revokeUserGrant(t.db, stranger.id, grant.familyId)).toBe(false);
      expect(await listConnectedApps(t.db, u.id)).toHaveLength(1);

      expect(await revokeUserGrant(t.db, u.id, grant.familyId)).toBe(true);
      expect(await listConnectedApps(t.db, u.id)).toEqual([]);
      expect(await revokeUserGrant(t.db, u.id, grant.familyId)).toBe(false);
    });
  });
});
