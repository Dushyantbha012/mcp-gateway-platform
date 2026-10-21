import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../crypto/oauth.js";
import { findPrincipalByAccessHash } from "../db/oauth.js";
import { insertServer } from "../db/servers.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import {
  buildTestApp,
  checkUntilConnected,
  TEST_ORIGIN,
  testOAuthConfig,
  userWithKey,
  userWithPassword,
} from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

const PASSWORD = "correct-horse-battery";
const REDIRECT = "http://127.0.0.1:33418/callback";

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

describe.skipIf(!hasTestDb)("OAuth authorization server", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Behind one proxy, so each registration below can come from its own IP
    // and the suite doesn't trip the per-IP registration limit.
    gw = buildTestApp(t.db, {}, { oauth: testOAuthConfig, trustProxyHops: 1 });
  });
  afterAll(async () => {
    await gw?.registry.closeAll();
    await t?.drop();
  });

  const register = (body: object = { client_name: "Claude Code", redirect_uris: [REDIRECT] }) =>
    request(gw.app)
      .post("/oauth/register")
      .set("X-Forwarded-For", `10.0.${n >> 8}.${++n & 255}`)
      .send(body);

  /** A dashboard user's session cookie. */
  async function loggedIn(role: "admin" | "member" = "member") {
    const u = await userWithPassword(t.db, `c${++n}@example.com`, role, PASSWORD);
    const res = await request(gw.app)
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ email: u.email, password: PASSWORD });
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
    return { ...u, cookie };
  }

  const authorize = (params: Record<string, string>) =>
    request(gw.app).get("/oauth/authorize").query(params);

  /** register -> authorize, returning the pending request id the dashboard gets. */
  async function pending(scope?: string) {
    const client = (await register()).body.client_id as string;
    const { verifier, challenge } = pkce();
    const res = await authorize({
      client_id: client,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st4te",
      resource: testOAuthConfig.resource,
      ...(scope ? { scope } : {}),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe(testOAuthConfig.consentUrl);
    return { client, verifier, reqId: location.searchParams.get("req")! };
  }

  const consentFor = (cookie: string) => ({
    get: (id: string) => request(gw.app).get(`/api/oauth/requests/${id}`).set("Cookie", cookie),
    decide: (id: string, body: object) =>
      request(gw.app)
        .post(`/api/oauth/requests/${id}`)
        .set("Cookie", cookie)
        .set("Origin", TEST_ORIGIN)
        .send(body),
  });

  /** The whole browser part: pending -> approve -> code. */
  async function code(scope?: string, scopes?: string[], role: "admin" | "member" = "member") {
    const p = await pending(scope);
    const user = await loggedIn(role);
    const res = await consentFor(user.cookie).decide(p.reqId, { approve: true, scopes });
    expect(res.status).toBe(200);
    const back = new URL(res.body.redirectUrl);
    expect(back.searchParams.get("state")).toBe("st4te");
    expect(back.searchParams.get("iss")).toBe(testOAuthConfig.issuer);
    return { ...p, user, code: back.searchParams.get("code")! };
  }

  const token = (body: Record<string, string>) =>
    request(gw.app).post("/oauth/token").type("form").send(body);

  async function tokens(scope?: string, role: "admin" | "member" = "member") {
    const c = await code(scope, undefined, role);
    const res = await token({
      grant_type: "authorization_code",
      client_id: c.client,
      code: c.code,
      code_verifier: c.verifier,
      redirect_uri: REDIRECT,
      resource: testOAuthConfig.resource,
    });
    expect(res.status).toBe(200);
    return {
      ...c,
      access: res.body.access_token as string,
      refresh: res.body.refresh_token as string,
    };
  }

  const accessWorks = async (access: string) =>
    (await findPrincipalByAccessHash(t.db, sha256(access))) !== undefined;

  describe("discovery", () => {
    it("serves protected-resource and authorization-server metadata, with CORS", async () => {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ]) {
        const res = await request(gw.app).get(path);
        expect(res.status).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe("*");
        expect(res.body).toMatchObject({
          resource: "http://gateway.test/mcp",
          authorization_servers: ["http://gateway.test"],
          scopes_supported: ["mcp:read", "mcp:write"],
        });
      }
      const as = await request(gw.app).get("/.well-known/oauth-authorization-server");
      expect(as.body).toMatchObject({
        issuer: "http://gateway.test",
        authorization_endpoint: "http://gateway.test/oauth/authorize",
        token_endpoint: "http://gateway.test/oauth/token",
        registration_endpoint: "http://gateway.test/oauth/register",
        revocation_endpoint: "http://gateway.test/oauth/revoke",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    });

    it("answers preflights for the token endpoint and /mcp, but not the cookie API", async () => {
      for (const path of ["/oauth/token", "/oauth/register", "/mcp"]) {
        const res = await request(gw.app)
          .options(path)
          .set("Origin", "http://localhost:6274")
          .set("Access-Control-Request-Method", "POST");
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-headers"]).toMatch(/Authorization/);
        expect(res.headers["access-control-expose-headers"]).toMatch(/WWW-Authenticate/);
      }
      const api = await request(gw.app).get("/api/meta").set("Origin", "http://evil.test");
      expect(api.headers["access-control-allow-origin"]).toBeUndefined();
      const authz = await authorize({});
      expect(authz.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("none of it exists with OAuth off", async () => {
      const off = buildTestApp(t.db);
      expect((await request(off.app).get("/.well-known/oauth-authorization-server")).status).toBe(
        404,
      );
      expect((await request(off.app).post("/oauth/register").send({})).status).toBe(404);
      const u = await userWithKey(t.db, `k${++n}@example.com`, "member");
      expect(
        (
          await request(off.app)
            .get("/api/oauth/requests/x")
            .set("Authorization", `Bearer ${u.key}`)
        ).status,
      ).toBe(404);
    });
  });

  describe("registration", () => {
    it("registers a public client", async () => {
      const res = await register();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        client_id: expect.stringMatching(/^mgc_/),
        client_name: "Claude Code",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      });
      expect(res.body.client_secret).toBeUndefined();
    });

    it("refuses bad redirect URIs, confidential clients and unknown grants", async () => {
      const bad = await register({ redirect_uris: ["http://evil.example.com/cb"] });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_redirect_uri");
      for (const body of [
        { redirect_uris: [] },
        { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
        { redirect_uris: [REDIRECT], grant_types: ["client_credentials"] },
        { redirect_uris: [REDIRECT], response_types: ["token"] },
      ]) {
        const res = await register(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_client_metadata");
      }
    });

    it("is rate limited per IP", async () => {
      const own = buildTestApp(t.db, {}, { oauth: testOAuthConfig });
      const reg = () =>
        request(own.app)
          .post("/oauth/register")
          .send({ redirect_uris: [REDIRECT] });
      for (let i = 0; i < 20; i++) expect((await reg()).status).toBe(201);
      const limited = await reg();
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    });
  });

  describe("authorize", () => {
    it("shows an error page, never a redirect, for an unknown client or redirect URI", async () => {
      const client = (await register()).body.client_id;
      for (const params of [
        { client_id: "mgc_unknownunknownunknow", redirect_uri: REDIRECT },
        { client_id: client, redirect_uri: "https://evil.example.com/cb" },
        { client_id: client, redirect_uri: "http://127.0.0.1:1/elsewhere" },
      ]) {
        const res = await authorize({ ...params, response_type: "code" });
        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
        expect(res.type).toBe("text/html");
        expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
      }
    });

    it("sends other problems back to the client, with its state", async () => {
      const client = (await register()).body.client_id;
      const { challenge } = pkce();
      const ok = {
        client_id: client,
        redirect_uri: "http://127.0.0.1:50000/callback", // any loopback port
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc",
      };
      const cases: [Record<string, string | undefined>, string][] = [
        [{ response_type: "token" }, "unsupported_response_type"],
        [{ code_challenge: undefined }, "invalid_request"],
        [{ code_challenge_method: "plain" }, "invalid_request"],
        [{ scope: "mcp:read admin" }, "invalid_scope"],
        [{ resource: "https://other.example.com/mcp" }, "invalid_target"],
      ];
      for (const [change, error] of cases) {
        const params = Object.fromEntries(
          Object.entries({ ...ok, ...change }).filter(([, v]) => v !== undefined),
        ) as Record<string, string>;
        const res = await authorize(params);
        expect(res.status).toBe(302);
        const back = new URL(res.headers.location);
        expect(back.origin + back.pathname).toBe("http://127.0.0.1:50000/callback");
        expect(back.searchParams.get("error")).toBe(error);
        expect(back.searchParams.get("state")).toBe("abc");
        expect(back.searchParams.get("iss")).toBe("http://gateway.test");
      }
    });
  });

  describe("consent", () => {
    it("needs a dashboard session, not an API key, and the dashboard's Origin", async () => {
      const p = await pending();
      expect((await request(gw.app).get(`/api/oauth/requests/${p.reqId}`)).status).toBe(401);
      const k = await userWithKey(t.db, `k${++n}@example.com`, "admin");
      const withKey = await request(gw.app)
        .get(`/api/oauth/requests/${p.reqId}`)
        .set("Authorization", `Bearer ${k.key}`);
      expect(withKey.status).toBe(403);

      const user = await loggedIn();
      const noOrigin = await request(gw.app)
        .post(`/api/oauth/requests/${p.reqId}`)
        .set("Cookie", user.cookie)
        .send({ approve: true });
      expect(noOrigin.status).toBe(403);
    });

    it("shows the client and what it asks for", async () => {
      const p = await pending("mcp:read");
      const user = await loggedIn();
      const res = await consentFor(user.cookie).get(p.reqId);
      expect(res.body).toMatchObject({
        clientId: p.client,
        clientName: "Claude Code",
        redirectHost: "127.0.0.1:33418",
        scopes: ["mcp:read"],
        resource: "http://gateway.test/mcp",
      });
      expect((await consentFor(user.cookie).get("not-a-uuid")).status).toBe(404);
    });

    it("deny sends access_denied back; a request is decided only once", async () => {
      const p = await pending();
      const user = await loggedIn();
      const res = await consentFor(user.cookie).decide(p.reqId, { approve: false });
      const back = new URL(res.body.redirectUrl);
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("state")).toBe("st4te");
      expect(back.searchParams.get("code")).toBeNull();
      expect((await consentFor(user.cookie).decide(p.reqId, { approve: true })).status).toBe(404);
    });

    it("the user can narrow the scope, never widen it, and it's audited", async () => {
      const p = await pending("mcp:read");
      const user = await loggedIn();
      const widen = await consentFor(user.cookie).decide(p.reqId, {
        approve: true,
        scopes: ["mcp:read", "mcp:write"],
      });
      expect(widen.status).toBe(400);

      const narrowed = await code(undefined, ["mcp:read"]);
      const res = await token({
        grant_type: "authorization_code",
        client_id: narrowed.client,
        code: narrowed.code,
        code_verifier: narrowed.verifier,
      });
      expect(res.body.scope).toBe("mcp:read");

      const audit = await t.db
        .selectFrom("audit_log")
        .selectAll()
        .where("user_id", "=", narrowed.user.user.id)
        .execute();
      expect(audit).toMatchObject([
        { tool_name: "oauth.approve", outcome: "success", detail: "Claude Code (mcp:read)" },
      ]);
    });
  });

  describe("token", () => {
    it("exchanges a code for tokens with PKCE, uncached", async () => {
      const c = await code();
      const res = await token({
        grant_type: "authorization_code",
        client_id: c.client,
        code: c.code,
        code_verifier: c.verifier,
        redirect_uri: REDIRECT,
      });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({
        access_token: expect.stringMatching(/^mgo_/),
        refresh_token: expect.stringMatching(/^mgr_/),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp:read mcp:write",
      });
      const p = await findPrincipalByAccessHash(t.db, sha256(res.body.access_token));
      expect(p).toMatchObject({ userId: c.user.user.id, resource: "http://gateway.test/mcp" });
    });

    it("accepts JSON too", async () => {
      const c = await code();
      const res = await request(gw.app).post("/oauth/token").send({
        grant_type: "authorization_code",
        client_id: c.client,
        code: c.code,
        code_verifier: c.verifier,
      });
      expect(res.status).toBe(200);
    });

    it("a wrong verifier, client or redirect URI fails, and burns the code", async () => {
      const other = (await register()).body.client_id;
      const cases: [Record<string, string>, string][] = [
        [{ code_verifier: pkce().verifier }, "invalid_grant"],
        [{ client_id: other }, "invalid_grant"],
        [{ redirect_uri: "http://127.0.0.1:33418/other" }, "invalid_grant"],
        [{ resource: "https://other.example.com/mcp" }, "invalid_target"],
      ];
      for (const [change, error] of cases) {
        const c = await code();
        const base = {
          grant_type: "authorization_code",
          client_id: c.client,
          code: c.code,
          code_verifier: c.verifier,
        };
        const bad = await token({ ...base, ...change });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe(error);
        const retry = await token(base);
        expect(retry.body.error).toBe("invalid_grant");
      }
    });

    it("a replayed code revokes the tokens it was exchanged for", async () => {
      const c = await tokens();
      expect(await accessWorks(c.access)).toBe(true);
      const replay = await token({
        grant_type: "authorization_code",
        client_id: c.client,
        code: c.code,
        code_verifier: c.verifier,
      });
      expect(replay.body.error).toBe("invalid_grant");
      expect(await accessWorks(c.access)).toBe(false);
    });

    it("rotates refresh tokens; reusing one ends the grant", async () => {
      const c = await tokens();
      const r1 = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: c.refresh,
      });
      expect(r1.status).toBe(200);
      expect(r1.body.refresh_token).not.toBe(c.refresh);
      expect(await accessWorks(r1.body.access_token)).toBe(true);

      const reuse = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: c.refresh,
      });
      expect(reuse.body.error).toBe("invalid_grant");
      expect(await accessWorks(r1.body.access_token)).toBe(false);
      const next = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: r1.body.refresh_token,
      });
      expect(next.body.error).toBe("invalid_grant");
    });

    it("a refresh can't add scope", async () => {
      const c = await code("mcp:read");
      const t1 = await token({
        grant_type: "authorization_code",
        client_id: c.client,
        code: c.code,
        code_verifier: c.verifier,
      });
      const res = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: t1.body.refresh_token,
        scope: "mcp:read mcp:write",
      });
      expect(res.body.error).toBe("invalid_scope");
    });

    it("a refresh can ask for less: that access token is narrowed, the grant isn't", async () => {
      const c = await tokens();
      const narrow = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: c.refresh,
        scope: "mcp:read",
      });
      expect(narrow.status).toBe(200);
      expect(narrow.body.scope).toBe("mcp:read");
      const p = await findPrincipalByAccessHash(t.db, sha256(narrow.body.access_token));
      expect(p?.oauth?.scopes).toEqual(["mcp:read"]);

      // Still one connected app, with what the user approved.
      const apps = await request(gw.app).get("/api/oauth/apps").set("Cookie", c.user.cookie);
      expect(apps.body).toHaveLength(1);
      expect(apps.body[0].scopes).toEqual(["mcp:read", "mcp:write"]);

      // The next refresh, with no scope, gets the whole grant again; write implies read.
      const full = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: narrow.body.refresh_token,
      });
      expect(full.body.scope).toBe("mcp:read mcp:write");
      const write = await token({
        grant_type: "refresh_token",
        client_id: c.client,
        refresh_token: full.body.refresh_token,
        scope: "mcp:write",
      });
      expect(write.body.scope).toBe("mcp:read mcp:write");
    });

    it("unknown clients and grant types get RFC 6749 errors", async () => {
      const unknown = await token({ grant_type: "authorization_code", client_id: "nope" });
      expect(unknown.status).toBe(401);
      expect(unknown.body.error).toBe("invalid_client");
      const client = (await register()).body.client_id;
      const grant = await token({ grant_type: "password", client_id: client });
      expect(grant.status).toBe(400);
      expect(grant.body).toMatchObject({
        error: "unsupported_grant_type",
        error_description: expect.any(String),
      });
    });
  });

  describe("revoke", () => {
    it("either token ends the grant; unknown tokens are still 200", async () => {
      const a = await tokens();
      expect(
        (await request(gw.app).post("/oauth/revoke").type("form").send({ token: a.refresh }))
          .status,
      ).toBe(200);
      expect(await accessWorks(a.access)).toBe(false);

      const b = await tokens();
      await request(gw.app).post("/oauth/revoke").send({ token: b.access });
      expect(await accessWorks(b.access)).toBe(false);
      const refresh = await token({
        grant_type: "refresh_token",
        client_id: b.client,
        refresh_token: b.refresh,
      });
      expect(refresh.body.error).toBe("invalid_grant");

      expect((await request(gw.app).post("/oauth/revoke").send({ token: "whatever" })).status).toBe(
        200,
      );
    });
  });

  describe("connected apps", () => {
    const apps = (cookie: string) => ({
      list: () => request(gw.app).get("/api/oauth/apps").set("Cookie", cookie),
      revoke: (id: string) =>
        request(gw.app)
          .delete(`/api/oauth/apps/${id}`)
          .set("Cookie", cookie)
          .set("Origin", TEST_ORIGIN),
    });

    it("lists the user's approved apps; revoking one ends its tokens and is audited", async () => {
      const c = await tokens();
      const mine = apps(c.user.cookie);
      const list = await mine.list();
      expect(list.body).toEqual([
        {
          id: expect.any(String),
          clientId: c.client,
          clientName: "Claude Code",
          scopes: ["mcp:read", "mcp:write"],
          createdAt: expect.any(String),
          lastUsedAt: null,
        },
      ]);
      expect(JSON.stringify(list.body)).not.toContain(c.access);

      // Someone else can't see or revoke it.
      const other = await loggedIn();
      expect((await apps(other.cookie).list()).body).toEqual([]);
      expect((await apps(other.cookie).revoke(list.body[0].id)).status).toBe(404);
      expect(await accessWorks(c.access)).toBe(true);

      expect((await mine.revoke(list.body[0].id)).status).toBe(204);
      expect(await accessWorks(c.access)).toBe(false);
      expect((await mine.list()).body).toEqual([]);
      expect((await mine.revoke(list.body[0].id)).status).toBe(404);
      expect((await mine.revoke("not-a-uuid")).status).toBe(404);

      const audit = await t.db
        .selectFrom("audit_log")
        .select(["tool_name", "detail"])
        .where("user_id", "=", c.user.user.id)
        .orderBy("ts")
        .execute();
      expect(audit.map((a) => a.tool_name)).toEqual(["oauth.approve", "oauth.revoke"]);
    });

    it("needs a session and the dashboard's Origin", async () => {
      const k = await userWithKey(t.db, `k${++n}@example.com`, "member");
      expect(
        (await request(gw.app).get("/api/oauth/apps").set("Authorization", `Bearer ${k.key}`))
          .status,
      ).toBe(403);
      const c = await tokens();
      const id = (await apps(c.user.cookie).list()).body[0].id;
      const noOrigin = await request(gw.app)
        .delete(`/api/oauth/apps/${id}`)
        .set("Cookie", c.user.cookie);
      expect(noOrigin.status).toBe(403);
    });

    it("/api/meta says OAuth is on", async () => {
      const u = await loggedIn();
      expect(
        (await request(gw.app).get("/api/meta").set("Cookie", u.cookie)).body.oauthEnabled,
      ).toBe(true);
    });
  });

  describe("/mcp as the resource server", () => {
    let upstream: FakeUpstream;
    let http: Server;
    let mcpUrl: string;

    beforeAll(async () => {
      upstream = await startFakeUpstream({
        toolNames: ["list_orders", "create_order"],
        readOnlyTools: ["list_orders"],
      });
      await insertServer(t.db, {
        id: randomUUID(),
        slug: "shop",
        name: "Shop",
        url: upstream.url,
        timeout_ms: 10_000,
      });
      await checkUntilConnected(gw);
      http = gw.app.listen(0, "127.0.0.1");
      await new Promise((resolve) => http.once("listening", resolve));
      mcpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    });
    afterAll(async () => {
      http?.closeAllConnections();
      await new Promise((resolve) => http?.close(resolve));
      await upstream?.close();
    });

    async function connect(bearer: string) {
      const client = new Client({ name: "oauth-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        }),
      );
      return client;
    }
    const names = async (client: Client) =>
      (await client.listTools()).tools.map((x) => x.name).filter((x) => x.startsWith("shop__"));
    const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
      (r.content as { type: string; text: string }[])[0].text;

    it("serves tools to an access token, as its user", async () => {
      const c = await tokens();
      const client = await connect(c.access);
      expect((await names(client)).sort()).toEqual(
        ["shop__big", "shop__create_order", "shop__fail", "shop__list_orders"].sort(),
      );
      const r = await client.callTool({ name: "shop__create_order", arguments: { value: "1" } });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toBe("create_order:1");
      await client.close();

      const audit = await t.db
        .selectFrom("audit_log")
        .selectAll()
        .where("user_id", "=", c.user.user.id)
        .where("source", "=", "mcp")
        .execute();
      expect(audit).toMatchObject([
        { tool_name: "shop__create_order", outcome: "success", api_key_id: null },
      ]);
    });

    it("mcp:read hides and refuses tools that change data, even for an admin", async () => {
      const c = await tokens("mcp:read", "admin");
      const client = await connect(c.access);
      expect(await names(client)).toEqual(["shop__list_orders"]);
      expect(text(await client.callTool({ name: "shop__list_orders", arguments: {} }))).toBe(
        "list_orders:",
      );
      const before = upstream.calls.create_order ?? 0;
      const refused = await client.callTool({ name: "shop__create_order", arguments: {} });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/only granted read access \(mcp:read\)/);
      expect(upstream.calls.create_order ?? 0).toBe(before);
      await client.close();
    });

    it("401s point at the metadata; a bad token also says invalid_token", async () => {
      const init = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      };
      const post = (auth?: string) => {
        const r = request(gw.app).post("/mcp").set("Accept", "application/json, text/event-stream");
        if (auth) r.set("Authorization", auth);
        return r.send(init);
      };
      const metadata =
        'Bearer resource_metadata="http://gateway.test/.well-known/oauth-protected-resource/mcp"';

      const none = await post();
      expect(none.status).toBe(401);
      expect(none.headers["www-authenticate"]).toBe(metadata);

      const fake = `mgo_${randomBytes(32).toString("base64url")}`;
      for (const auth of [`Bearer ${fake}`, "Bearer garbage"]) {
        const bad = await post(auth);
        expect(bad.status).toBe(401);
        expect(bad.headers["www-authenticate"]).toBe(`${metadata}, error="invalid_token"`);
      }

      // API keys keep working next to OAuth.
      const k = await userWithKey(t.db, `k${++n}@example.com`, "member");
      expect((await post(`Bearer ${k.key}`)).status).toBe(200);
    });

    it("refuses revoked tokens, and tokens for another resource", async () => {
      const a = await tokens();
      await request(gw.app).post("/oauth/revoke").send({ token: a.refresh });
      await expect(connect(a.access)).rejects.toThrow();

      const b = await tokens();
      await t.db
        .updateTable("oauth_tokens")
        .set({ resource: "https://other.example.com/mcp" })
        .where("hash", "=", sha256(b.access))
        .execute();
      await expect(connect(b.access)).rejects.toThrow();
    });

    it("with OAuth off, an access token is just an invalid key", async () => {
      const c = await tokens();
      const off = buildTestApp(t.db);
      const res = await request(off.app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .set("Authorization", `Bearer ${c.access}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Bearer realm="mcp-gateway"');
    });
  });
});
