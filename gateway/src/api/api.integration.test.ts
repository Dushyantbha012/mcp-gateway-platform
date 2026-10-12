import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { insertAuditEntry } from "../db/audit.js";
import { getServerBySlug } from "../db/servers.js";
import { deadUrl, startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

describe.skipIf(!hasTestDb)("REST API", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let admin: Awaited<ReturnType<typeof userWithKey>>;
  let member: Awaited<ReturnType<typeof userWithKey>>;
  const fakes: FakeUpstream[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db);
    admin = await userWithKey(t.db, "admin@example.com", "admin");
    member = await userWithKey(t.db, "member@example.com", "member");
  });
  afterEach(async () => {
    await gw.registry.closeAll();
    await Promise.all(fakes.splice(0).map((f) => f.close()));
    await t.db.deleteFrom("mcp_servers").execute();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const as = (who: { key: string }) => ({
    get: (path: string) => request(gw.app).get(path).set("Authorization", `Bearer ${who.key}`),
    post: (path: string, body?: object) =>
      request(gw.app).post(path).set("Authorization", `Bearer ${who.key}`).send(body),
    patch: (path: string, body: object) =>
      request(gw.app).patch(path).set("Authorization", `Bearer ${who.key}`).send(body),
    delete: (path: string) =>
      request(gw.app).delete(path).set("Authorization", `Bearer ${who.key}`),
  });

  async function fake(opts: Parameters<typeof startFakeUpstream>[0] = {}) {
    const f = await startFakeUpstream(opts);
    fakes.push(f);
    return f;
  }

  describe("auth", () => {
    it("requires a valid key on every /api route", async () => {
      const res = await request(gw.app).get("/api/servers");
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
      expect(res.body.error.code).toBe("unauthorized");
      expect((await request(gw.app).get("/api/me").set("Authorization", "Bearer x")).status).toBe(
        401,
      );
    });

    it("returns the caller from /api/me", async () => {
      const res = await as(member).get("/api/me");
      expect(res.body).toMatchObject({ email: "member@example.com", role: "member" });
    });

    it.each([
      ["post", "/api/servers"],
      ["get", "/api/users"],
      ["post", "/api/users"],
      ["get", "/api/audit"],
    ] as const)("forbids members from %s %s", async (method, path) => {
      const res = await as(member)[method](path, {});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("answers unknown routes and malformed JSON with clean errors", async () => {
      expect((await as(admin).get("/api/nope")).status).toBe(404);
      const res = await request(gw.app)
        .post("/api/users")
        .set("Authorization", `Bearer ${admin.key}`)
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    });
  });

  describe("servers", () => {
    it("adds a server with a credential, checks it immediately, and never returns the credential", async () => {
      const f = await fake();
      const res = await as(admin).post("/api/servers", {
        slug: "github",
        name: "GitHub",
        url: f.url,
        authType: "bearer",
        credential: "ghp_supersecretvalue",
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        slug: "github",
        status: "connected",
        hasCredential: true,
        authType: "bearer",
      });
      expect(res.body.tools.map((x: { name: string }) => x.name)).toContain(
        "github__list_products",
      );
      expect(f.requests.every((h) => h.authorization === "Bearer ghp_supersecretvalue")).toBe(true);

      // The credential is in the credential store (a Kubernetes Secret in
      // production), flagged in the row, and appears in no response - nor in
      // the database row itself.
      const stored = await getServerBySlug(t.db, "github");
      expect(stored!.has_credential).toBe(true);
      expect(Object.keys(stored!)).not.toContain("credential_ciphertext");
      expect(JSON.stringify(stored)).not.toContain("ghp_supersecretvalue");
      expect((await gw.credentials.get(stored!.id))?.value).toBe("ghp_supersecretvalue");
      const ciphertext = "ghp_supersecretvalue";
      for (const who of [admin, member]) {
        for (const path of ["/api/servers", `/api/servers/${res.body.id}`]) {
          const raw = (await as(who).get(path)).text;
          expect(raw).not.toContain("ghp_supersecretvalue");
          expect(raw).not.toContain(ciphertext);
        }
      }
      expect(JSON.stringify(res.body)).not.toContain("ghp_supersecretvalue");
    });

    it("hides upstream URLs from members", async () => {
      const f = await fake();
      await as(admin).post("/api/servers", { slug: "docs", name: "Docs", url: f.url });
      const [asMember] = (await as(member).get("/api/servers")).body;
      const [asAdmin] = (await as(admin).get("/api/servers")).body;
      expect(asMember).not.toHaveProperty("url");
      expect(asAdmin.url).toBe(f.url);
    });

    it("reports an unreachable server with its reason", async () => {
      const res = await as(admin).post("/api/servers", {
        slug: "dead",
        name: "Dead",
        url: await deadUrl(),
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("unreachable");
      expect(res.body.lastError).toMatch(/ECONNREFUSED/);
    });

    it.each([
      [{ slug: "Bad_Slug", name: "x", url: "http://a.test/mcp" }, /slug/],
      [{ slug: "ok", name: "x", url: "ftp://a.test" }, /url/],
      [
        { slug: "ok", name: "x", url: "http://a.test", authType: "bearer" },
        /credential is required/,
      ],
      [
        { slug: "ok", name: "x", url: "http://a.test", authType: "header", credential: "c" },
        /authHeaderName is required/,
      ],
      [
        {
          slug: "ok",
          name: "x",
          url: "http://a.test",
          authType: "header",
          authHeaderName: "Mcp-Session-Id",
          credential: "c",
        },
        /reserved/,
      ],
      [{ slug: "ok", name: "x", url: "http://a.test", timeoutMs: 5 }, /timeoutMs/],
    ])("rejects invalid server %j", async (body, message) => {
      const res = await as(admin).post("/api/servers", body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(message);
    });

    it("rejects a duplicate slug with 409", async () => {
      const f = await fake();
      await as(admin).post("/api/servers", { slug: "twice", name: "A", url: f.url });
      const res = await as(admin).post("/api/servers", { slug: "twice", name: "B", url: f.url });
      expect(res.status).toBe(409);
    });

    it("edits, disables, re-enables and deletes a server; edits take effect immediately", async () => {
      const first = await fake();
      const second = await fake();
      const created = (
        await as(admin).post("/api/servers", {
          slug: "edit-me",
          name: "Edit",
          url: first.url,
          authType: "header",
          authHeaderName: "X-Api-Key",
          credential: "old-key",
        })
      ).body;

      const moved = await as(admin).patch(`/api/servers/${created.id}`, {
        url: second.url,
        credential: "new-key",
      });
      expect(moved.status).toBe(200);
      expect(moved.body.status).toBe("connected");
      expect(second.requests.every((h) => h["x-api-key"] === "new-key")).toBe(true);

      const disabled = await as(admin).patch(`/api/servers/${created.id}`, { enabled: false });
      expect(disabled.body.status).toBe("disabled");

      const enabled = await as(admin).patch(`/api/servers/${created.id}`, { enabled: true });
      expect(enabled.body.status).toBe("connected");

      // Switching to no auth drops the stored credential.
      const noAuth = await as(admin).patch(`/api/servers/${created.id}`, { authType: "none" });
      expect(noAuth.body).toMatchObject({ hasCredential: false, authHeaderName: null });

      expect((await as(admin).delete(`/api/servers/${created.id}`)).status).toBe(204);
      expect((await as(admin).get(`/api/servers/${created.id}`)).status).toBe(404);
    });

    it("rejects unknown fields and bad ids", async () => {
      const f = await fake();
      const { id } = (await as(admin).post("/api/servers", { slug: "s1", name: "S", url: f.url }))
        .body;
      expect((await as(admin).patch(`/api/servers/${id}`, { status: "connected" })).status).toBe(
        400,
      );
      expect((await as(admin).get("/api/servers/not-a-uuid")).status).toBe(404);
    });

    it("refreshes a server's status on demand", async () => {
      const f = await fake();
      const { id } = (
        await as(admin).post("/api/servers", { slug: "refresh-me", name: "R", url: f.url })
      ).body;
      f.behavior = "http500";
      const res = await as(admin).post(`/api/servers/${id}/refresh`);
      expect(res.body.status).toBe("unreachable");
    });
  });

  describe("users and keys", () => {
    it("invites a user, issues a key once, and the key works until revoked", async () => {
      const invited = await as(admin).post("/api/users", {
        email: "New.Person@Example.com",
        name: "New Person",
      });
      expect(invited.status).toBe(201);
      expect(invited.body).toMatchObject({ email: "new.person@example.com", role: "member" });

      const issued = await as(admin).post(`/api/users/${invited.body.id}/keys`, { name: "laptop" });
      expect(issued.status).toBe(201);
      expect(issued.body.key).toMatch(/^mgw_/);
      expect(issued.body.prefix).toBe(issued.body.key.slice(0, 12));

      const listed = await as(admin).get(`/api/users/${invited.body.id}/keys`);
      expect(JSON.stringify(listed.body)).not.toContain(issued.body.key);
      expect(listed.body[0]).not.toHaveProperty("key_hash");

      const newUser = { key: issued.body.key as string };
      expect((await as(newUser).get("/api/me")).status).toBe(200);
      const revoked = await as(admin).delete(`/api/keys/${issued.body.id}`);
      expect(revoked.body.revokedAt).not.toBeNull();
      expect((await as(newUser).get("/api/me")).status).toBe(401);
    });

    it("rejects duplicate emails with 409", async () => {
      const res = await as(admin).post("/api/users", { email: "member@example.com", name: "Dup" });
      expect(res.status).toBe(409);
    });

    it("lets members manage only their own keys", async () => {
      const own = await as(member).post("/api/users/me/keys", { name: "cli" });
      expect(own.status).toBe(201);
      expect((await as(member).get(`/api/users/${admin.user.id}/keys`)).status).toBe(403);
      expect(
        (await as(member).post(`/api/users/${admin.user.id}/keys`, { name: "x" })).status,
      ).toBe(403);
      // Another user's key id looks like a missing one.
      expect((await as(member).delete(`/api/keys/${admin.keyId}`)).status).toBe(404);
      expect((await as(member).delete(`/api/keys/${own.body.id}`)).status).toBe(200);
    });
  });

  describe("audit", () => {
    it("lists entries newest first with filters and paging", async () => {
      for (const [slug, tool] of [
        ["woocommerce", "woocommerce__list_orders"],
        ["github", "github__search"],
        ["woocommerce", "woocommerce__get_order"],
      ]) {
        await insertAuditEntry(t.db, {
          user_id: member.user.id,
          user_email: member.user.email,
          api_key_id: member.keyId,
          source: "mcp",
          server_slug: slug,
          tool_name: tool,
          duration_ms: 12,
          outcome: "success",
          error: null,
        });
      }
      const all = (await as(admin).get("/api/audit")).body;
      expect(all.slice(0, 3).map((e: { tool: string }) => e.tool)).toEqual([
        "woocommerce__get_order",
        "github__search",
        "woocommerce__list_orders",
      ]);
      expect(all[0]).toMatchObject({ userEmail: "member@example.com", outcome: "success" });

      const woo = (await as(admin).get("/api/audit?server=woocommerce")).body;
      expect(woo.every((e: { server: string }) => e.server === "woocommerce")).toBe(true);

      const page = (await as(admin).get(`/api/audit?before=${all[0].id}&limit=1`)).body;
      expect(page.map((e: { tool: string }) => e.tool)).toEqual(["github__search"]);

      expect((await as(admin).get("/api/audit?limit=9999")).status).toBe(400);
    });

    it("filters by outcome and source", async () => {
      for (const [source, outcome] of [
        ["chat", "timeout"],
        ["mcp", "rejected"],
        ["chat", "success"],
      ] as const) {
        await insertAuditEntry(t.db, {
          user_id: member.user.id,
          user_email: member.user.email,
          api_key_id: null,
          source,
          server_slug: "woocommerce",
          tool_name: `woocommerce__${source}_${outcome}`,
          duration_ms: 5,
          outcome,
          error: null,
        });
      }
      const tools = async (query: string) =>
        ((await as(admin).get(`/api/audit?${query}`)).body as { tool: string }[]).map(
          (e) => e.tool,
        );
      expect(await tools("outcome=timeout")).toEqual(["woocommerce__chat_timeout"]);
      expect(await tools("source=chat")).toEqual([
        "woocommerce__chat_success",
        "woocommerce__chat_timeout",
      ]);
      expect(await tools("source=chat&outcome=success")).toEqual(["woocommerce__chat_success"]);
      expect((await as(admin).get("/api/audit?outcome=great")).status).toBe(400);
      expect((await as(admin).get("/api/audit?source=email")).status).toBe(400);
    });
  });
});
