import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertServer } from "../db/servers.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, TEST_ORIGIN, userWithKey, userWithPassword } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

const PASSWORD = "correct-horse-battery";

/** The `mgw_session=<token>` pair from a response's Set-Cookie, or undefined. */
function sessionCookie(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith("mgw_session="));
  const pair = cookie?.split(";")[0];
  return pair && pair !== "mgw_session=" ? pair : undefined;
}

describe.skipIf(!hasTestDb)("dashboard auth", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let n = 0;
  const bodies: string[] = []; // every response body, for the leak check at the end

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db);
  });
  afterAll(async () => {
    await gw?.registry.closeAll();
    await t?.drop();
  });

  const record = (res: request.Response) => {
    bodies.push(res.text ?? "");
    return res;
  };

  const login = async (email: string, password: string, origin: string | null = TEST_ORIGIN) => {
    const req = request(gw.app).post("/api/auth/login");
    if (origin) req.set("Origin", origin);
    return record(await req.send({ email, password }));
  };

  /** Requests as a logged-in browser: the session cookie plus the dashboard's Origin. */
  const browser = (cookie: string, origin: string | null = TEST_ORIGIN) => {
    const wrap = (r: request.Test) => {
      r.set("Cookie", cookie);
      if (origin) r.set("Origin", origin);
      return r.then(record);
    };
    return {
      get: (path: string) => wrap(request(gw.app).get(path)),
      post: (path: string, body?: object) => wrap(request(gw.app).post(path).send(body)),
      patch: (path: string, body: object) => wrap(request(gw.app).patch(path).send(body)),
      delete: (path: string) => wrap(request(gw.app).delete(path)),
    };
  };

  const newUser = (role: "admin" | "member" = "member") =>
    userWithPassword(t.db, `user${++n}@example.com`, role, PASSWORD);

  async function loggedIn(role: "admin" | "member" = "member") {
    const u = await newUser(role);
    const res = await login(u.email, PASSWORD);
    expect(res.status).toBe(200);
    return { ...u, cookie: sessionCookie(res)!, as: browser(sessionCookie(res)!) };
  }

  describe("login", () => {
    it("sets an HttpOnly, SameSite=Strict cookie scoped to /api and returns the user", async () => {
      const u = await newUser();
      const res = await login(u.email.toUpperCase(), PASSWORD); // emails are case-insensitive
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email: u.email, role: "member", hasPassword: true });
      const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
      expect(cookie).toMatch(/^mgw_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toMatch(/; Path=\/api/);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Strict/);
      expect(cookie).toMatch(/; Max-Age=3600/);
      expect(cookie).not.toMatch(/Secure/);
    });

    it("adds Secure when configured (production behind TLS)", async () => {
      const secure = buildTestApp(t.db, { cookieSecure: true });
      const u = await newUser();
      const res = await request(secure.app)
        .post("/api/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: u.email, password: PASSWORD });
      expect((res.headers["set-cookie"] as unknown as string[])[0]).toMatch(/; Secure/);
    });

    it("gives the same 401 for a wrong password, an unknown email, no password, or a disabled user", async () => {
      const u = await newUser();
      const disabled = await newUser();
      await t.db
        .updateTable("users")
        .set({ disabled_at: new Date() })
        .where("id", "=", disabled.user.id)
        .execute();
      const invited = await userWithKey(t.db, `nopw${++n}@example.com`, "member");

      const results = await Promise.all([
        login(u.email, "wrong-password-123"),
        login("nobody@example.com", PASSWORD),
        login(invited.user.email, PASSWORD),
        login(disabled.email, PASSWORD),
      ]);
      for (const res of results) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          error: { code: "invalid_credentials", message: "Invalid email or password" },
        });
        expect(sessionCookie(res)).toBeUndefined();
      }
    });

    it("rejects a login from another origin, or with no Origin (login CSRF)", async () => {
      const u = await newUser();
      for (const origin of ["http://evil.test", null]) {
        const res = await login(u.email, PASSWORD, origin);
        expect(res.status).toBe(403);
        expect(sessionCookie(res)).toBeUndefined();
      }
    });

    it("rejects malformed bodies with 400", async () => {
      const res = record(
        await request(gw.app).post("/api/auth/login").set("Origin", TEST_ORIGIN).send({ email: 1 }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("login rate limit", () => {
    // Own app, so these failures don't count against the other tests' IP.
    // trustProxyHops=1 makes req.ip come from X-Forwarded-For.
    let rl: ReturnType<typeof buildTestApp>;
    beforeAll(() => {
      rl = buildTestApp(t.db, {}, { trustProxyHops: 1 });
    });
    const attempt = (email: string, password: string, ip: string) =>
      request(rl.app)
        .post("/api/auth/login")
        .set("Origin", TEST_ORIGIN)
        .set("X-Forwarded-For", ip)
        .send({ email, password });

    it("blocks an email after 10 failures, from any IP, even with the right password", async () => {
      const u = await newUser();
      for (let i = 0; i < 10; i++) {
        expect((await attempt(u.email, "wrong-password-123", `10.0.0.${i}`)).status).toBe(401);
      }
      const blocked = await attempt(u.email, PASSWORD, "10.0.1.1");
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      // Another account is unaffected.
      const other = await newUser();
      expect((await attempt(other.email, PASSWORD, "10.0.1.2")).status).toBe(200);
    });

    it("blocks an IP after 10 failures across many emails", async () => {
      for (let i = 0; i < 10; i++) {
        expect((await attempt(`spray${i}@example.com`, PASSWORD, "10.9.9.9")).status).toBe(401);
      }
      const u = await newUser();
      expect((await attempt(u.email, PASSWORD, "10.9.9.9")).status).toBe(429);
      expect((await attempt(u.email, PASSWORD, "10.9.9.10")).status).toBe(200);
    });
  });

  describe("sessions", () => {
    it("authenticate /api, including role checks", async () => {
      const member = await loggedIn("member");
      expect((await member.as.get("/api/me")).body).toMatchObject({ email: member.email });
      expect((await member.as.get("/api/servers")).status).toBe(200);
      expect((await member.as.get("/api/users")).status).toBe(403);
      expect((await member.as.get("/api/audit")).status).toBe(403);
      expect((await member.as.get("/api/stats")).status).toBe(403);
      expect((await member.as.post("/api/servers", {})).status).toBe(403);

      const admin = await loggedIn("admin");
      expect((await admin.as.get("/api/users")).status).toBe(200);
      const stats = await admin.as.get("/api/stats?range=7d");
      expect(stats.status).toBe(200);
      expect(stats.body).toMatchObject({ range: "7d", bucket: "day" });
      expect(stats.body.totals.total).toEqual(expect.any(Number));
      expect((await admin.as.get("/api/stats?range=1y")).status).toBe(400);
    });

    it("are not accepted by /mcp (MCP clients use API keys)", async () => {
      const member = await loggedIn("member");
      const res = await request(gw.app)
        .post("/mcp")
        .set("Cookie", member.cookie)
        .set("Origin", TEST_ORIGIN)
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status).toBe(401);
    });

    it("need an allowed Origin for changes, but not for reads", async () => {
      const member = await loggedIn("member");
      const noOrigin = browser(member.cookie, null);
      const evil = browser(member.cookie, "http://evil.test");
      expect((await noOrigin.get("/api/me")).status).toBe(200);
      for (const as of [noOrigin, evil]) {
        const res = await as.post("/api/users/me/keys", { name: "csrf" });
        expect(res.status).toBe(403);
        expect(res.body.error.message).toMatch(/Cross-origin/);
      }
      expect((await member.as.post("/api/users/me/keys", { name: "ok" })).status).toBe(201);
    });

    it("an API key needs no Origin (not a browser credential)", async () => {
      const k = await userWithKey(t.db, `key${++n}@example.com`, "member");
      const res = await request(gw.app)
        .post("/api/users/me/keys")
        .set("Authorization", `Bearer ${k.key}`)
        .send({ name: "script" });
      expect(res.status).toBe(201);
    });

    it("a bad Bearer header isn't rescued by a valid cookie", async () => {
      const member = await loggedIn("member");
      const res = await request(gw.app)
        .get("/api/me")
        .set("Cookie", member.cookie)
        .set("Authorization", "Bearer mgw_nope");
      expect(res.status).toBe(401);
    });

    it("end at logout, and logout is idempotent", async () => {
      const member = await loggedIn("member");
      const out = await member.as.post("/api/auth/logout");
      expect(out.status).toBe(204);
      expect((out.headers["set-cookie"] as unknown as string[])[0]).toMatch(
        /^mgw_session=;.*Expires=Thu, 01 Jan 1970/,
      );
      expect((await member.as.get("/api/me")).status).toBe(401);
      expect((await member.as.post("/api/auth/logout")).status).toBe(204);
      expect(
        (await request(gw.app).post("/api/auth/logout").set("Origin", TEST_ORIGIN)).status,
      ).toBe(204);
    });

    it("stop working once expired", async () => {
      const member = await loggedIn("member");
      await t.db
        .updateTable("sessions")
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where("user_id", "=", member.user.id)
        .execute();
      const res = await member.as.get("/api/me");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("are rejected for garbage cookies without a DB lookup error", async () => {
      for (const cookie of [
        "mgw_session=",
        "mgw_session=abc",
        "other=1",
        `mgw_session=${"x".repeat(43)}`,
      ]) {
        expect((await browser(cookie).get("/api/me")).status).toBe(401);
      }
    });
  });

  describe("invites", () => {
    it("admin invites -> link shown once -> member sets a password -> logged in", async () => {
      const admin = await loggedIn("admin");
      const created = await admin.as.post("/api/users", {
        email: `new${++n}@example.com`,
        name: "New",
      });
      expect(created.status).toBe(201);
      expect(created.body.hasPassword).toBe(false);
      const url = new URL(created.body.inviteUrl);
      expect(url.origin).toBe(TEST_ORIGIN);
      const token = url.pathname.split("/").pop()!;
      expect(new Date(created.body.inviteExpiresAt).getTime()).toBeGreaterThan(Date.now());

      // The token isn't in any later response.
      expect((await admin.as.get("/api/users")).text).not.toContain(token);

      const info = record(await request(gw.app).get(`/api/auth/invites/${token}`));
      expect(info.body).toEqual({ email: created.body.email, name: "New", isReset: false });

      const accept = (password: string) =>
        request(gw.app)
          .post(`/api/auth/invites/${token}/accept`)
          .set("Origin", TEST_ORIGIN)
          .send({ password })
          .then(record);
      expect((await accept("short")).status).toBe(400); // too short: invite still usable
      const ok = await accept(PASSWORD);
      expect(ok.status).toBe(200);
      expect(ok.body.email).toBe(created.body.email);
      const cookie = sessionCookie(ok)!;
      expect((await browser(cookie).get("/api/me")).body.hasPassword).toBe(true);

      // Single use; and the password now works for login.
      expect((await accept(PASSWORD)).status).toBe(404);
      expect((await request(gw.app).get(`/api/auth/invites/${token}`)).status).toBe(404);
      expect((await login(created.body.email, PASSWORD)).status).toBe(200);
    });

    it("re-inviting voids the old link, and acts as a password reset that ends sessions", async () => {
      const admin = await loggedIn("admin");
      const member = await loggedIn("member");
      const first = await admin.as.post(`/api/users/${member.user.id}/invite`);
      const second = await admin.as.post(`/api/users/${member.user.id}/invite`);
      expect(second.status).toBe(201);
      const tokenOf = (r: request.Response) => r.body.inviteUrl.split("/").pop();
      expect((await request(gw.app).get(`/api/auth/invites/${tokenOf(first)}`)).status).toBe(404);
      const info = await request(gw.app).get(`/api/auth/invites/${tokenOf(second)}`);
      expect(info.body.isReset).toBe(true);

      const accepted = await request(gw.app)
        .post(`/api/auth/invites/${tokenOf(second)}/accept`)
        .set("Origin", TEST_ORIGIN)
        .send({ password: "a-brand-new-password" });
      expect(accepted.status).toBe(200);
      expect((await member.as.get("/api/me")).status).toBe(401); // old session ended
      expect((await login(member.email, PASSWORD)).status).toBe(401);
      expect((await login(member.email, "a-brand-new-password")).status).toBe(200);
    });

    it("rejects expired, malformed and cross-origin accepts", async () => {
      const admin = await loggedIn("admin");
      const created = await admin.as.post("/api/users", {
        email: `exp${++n}@example.com`,
        name: "E",
      });
      const token = created.body.inviteUrl.split("/").pop();

      const crossOrigin = await request(gw.app)
        .post(`/api/auth/invites/${token}/accept`)
        .set("Origin", "http://evil.test")
        .send({ password: PASSWORD });
      expect(crossOrigin.status).toBe(403);

      await t.db
        .updateTable("invites")
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where("user_id", "=", created.body.id)
        .execute();
      expect((await request(gw.app).get(`/api/auth/invites/${token}`)).status).toBe(404);
      for (const bad of ["nope", "x".repeat(43)]) {
        expect((await request(gw.app).get(`/api/auth/invites/${bad}`)).status).toBe(404);
      }
    });

    it("can't be issued for a disabled user, and only by admins", async () => {
      const admin = await loggedIn("admin");
      const member = await loggedIn("member");
      expect((await member.as.post(`/api/users/${admin.user.id}/invite`)).status).toBe(403);
      await admin.as.patch(`/api/users/${member.user.id}`, { disabled: true });
      expect((await admin.as.post(`/api/users/${member.user.id}/invite`)).status).toBe(409);
    });

    it("builds a relative link when no dashboard URL is configured", async () => {
      const bare = buildTestApp(t.db, { dashboardUrl: undefined });
      const k = await userWithKey(t.db, `adm${++n}@example.com`, "admin");
      const res = await request(bare.app)
        .post("/api/users")
        .set("Authorization", `Bearer ${k.key}`)
        .send({ email: `rel${++n}@example.com`, name: "R" });
      expect(res.body.inviteUrl).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    });
  });

  describe("managing users", () => {
    it("disabling a user ends their sessions and stops their API keys at once; re-enabling restores keys", async () => {
      const admin = await loggedIn("admin");
      const member = await loggedIn("member");
      const key = (await member.as.post("/api/users/me/keys", { name: "laptop" })).body.key;
      const withKey = () => request(gw.app).get("/api/me").set("Authorization", `Bearer ${key}`);
      expect((await withKey()).status).toBe(200);

      const res = await admin.as.patch(`/api/users/${member.user.id}`, { disabled: true });
      expect(res.status).toBe(200);
      expect(res.body.disabledAt).not.toBeNull();
      expect((await member.as.get("/api/me")).status).toBe(401);
      expect((await withKey()).status).toBe(401);

      await admin.as.patch(`/api/users/${member.user.id}`, { disabled: false });
      expect((await withKey()).status).toBe(200);
      expect((await member.as.get("/api/me")).status).toBe(401); // sessions stay ended
    });

    it("changes name and role", async () => {
      const admin = await loggedIn("admin");
      const member = await loggedIn("member");
      const res = await admin.as.patch(`/api/users/${member.user.id}`, {
        name: "Promoted",
        role: "admin",
      });
      expect(res.body).toMatchObject({ name: "Promoted", role: "admin" });
      // Takes effect on the member's very next request (no role cache).
      expect((await member.as.get("/api/users")).status).toBe(200);
    });

    it("won't let an admin disable or demote themselves", async () => {
      const admin = await loggedIn("admin");
      for (const change of [{ disabled: true }, { role: "member" }]) {
        const res = await admin.as.patch(`/api/users/${admin.user.id}`, change);
        expect(res.status).toBe(409);
      }
      expect((await admin.as.patch(`/api/users/${admin.user.id}`, { name: "Me" })).status).toBe(
        200,
      );
    });

    it("never removes the last enabled admin", { timeout: 20_000 }, async () => {
      const iso = await createTestDatabase();
      try {
        const app = buildTestApp(iso.db).app;
        const a = await userWithKey(iso.db, "a@example.com", "admin");
        const b = await userWithKey(iso.db, "b@example.com", "admin");
        const patch = (who: { key: string }, id: string, body: object) =>
          request(app)
            .patch(`/api/users/${id}`)
            .set("Authorization", `Bearer ${who.key}`)
            .send(body);
        expect((await patch(a, b.user.id, { role: "member" })).status).toBe(200);
        // b is now a member; a is the last admin and can't be removed by anyone.
        const c = await userWithKey(iso.db, "c@example.com", "admin");
        expect((await patch(c, a.user.id, { disabled: true })).status).toBe(200);
        const last = await patch(c, c.user.id, { role: "member" });
        expect(last.status).toBe(409);
      } finally {
        await iso.drop();
      }
    });

    it("validates the change and 404s unknown users", async () => {
      const admin = await loggedIn("admin");
      expect((await admin.as.patch(`/api/users/${admin.user.id}`, {})).status).toBe(400);
      expect((await admin.as.patch(`/api/users/${admin.user.id}`, { role: "owner" })).status).toBe(
        400,
      );
      expect((await admin.as.patch(`/api/users/${admin.user.id}`, { email: "x@y.z" })).status).toBe(
        400,
      );
      expect(
        (await admin.as.patch("/api/users/00000000-0000-0000-0000-000000000000", { name: "x" }))
          .status,
      ).toBe(404);
      expect((await admin.as.patch("/api/users/not-a-uuid", { name: "x" })).status).toBe(404);
    });

    it("members can't change users", async () => {
      const member = await loggedIn("member");
      expect(
        (await member.as.patch(`/api/users/${member.user.id}`, { role: "admin" })).status,
      ).toBe(403);
    });
  });

  describe("change password", () => {
    it("needs the current password and ends the user's other sessions", async () => {
      const member = await loggedIn("member");
      const other = browser(sessionCookie(await login(member.email, PASSWORD))!);

      const wrong = await member.as.post("/api/me/password", {
        currentPassword: "not-my-password",
        newPassword: "another-long-password",
      });
      expect(wrong.status).toBe(400);
      const tooShort = await member.as.post("/api/me/password", {
        currentPassword: PASSWORD,
        newPassword: "short",
      });
      expect(tooShort.status).toBe(400);

      const ok = await member.as.post("/api/me/password", {
        currentPassword: PASSWORD,
        newPassword: "another-long-password",
      });
      expect(ok.status).toBe(204);
      expect((await member.as.get("/api/me")).status).toBe(200); // this session stays
      expect((await other.get("/api/me")).status).toBe(401);
      expect((await login(member.email, "another-long-password")).status).toBe(200);
    });

    it("isn't available with an API key", async () => {
      const k = await userWithKey(t.db, `pwkey${++n}@example.com`, "member");
      const res = await request(gw.app)
        .post("/api/me/password")
        .set("Authorization", `Bearer ${k.key}`)
        .send({ currentPassword: "x", newPassword: "another-long-password" });
      expect(res.status).toBe(403);
    });
  });

  describe("tools and meta", () => {
    let fake: FakeUpstream;
    afterAll(async () => {
      await fake?.close();
    });

    it("/api/tools is what the caller's MCP client lists, and follows disable/enable at once", async () => {
      fake = await startFakeUpstream({ toolNames: ["echo", "add"] });
      const admin = await loggedIn("admin");
      const member = await loggedIn("member");
      const server = await insertServer(t.db, {
        slug: "toolsrv",
        name: "Tool Server",
        url: fake.url,
      });
      await gw.health.check(server);

      // The fake always adds "fail" and "big" to the tools it's given.
      const all = ["toolsrv__add", "toolsrv__big", "toolsrv__echo", "toolsrv__fail"];
      const names = async () =>
        ((await member.as.get("/api/tools")).body as { name: string }[]).map((x) => x.name).sort();
      expect(await names()).toEqual(all);
      await admin.as.patch(`/api/servers/${server.id}`, { enabled: false });
      expect(await names()).toEqual([]);
      await admin.as.patch(`/api/servers/${server.id}`, { enabled: true });
      expect(await names()).toEqual(all);
    });

    it("/api/meta gives the public MCP URL and whether chat is on", async () => {
      const member = await loggedIn("member");
      expect((await member.as.get("/api/meta")).body).toEqual({
        mcpUrl: "http://gateway.test/mcp",
        chatEnabled: false,
        chatProviders: [],
        chatProvider: null,
        searchMode: "off",
        oauthEnabled: false,
      });
    });
  });

  describe("no secrets in any response", () => {
    it("never returns password hashes, token hashes or session tokens in a body", async () => {
      expect(bodies.length).toBeGreaterThan(50);
      const all = bodies.join("\n");
      expect(all).not.toMatch(/scrypt\$/);
      expect(all).not.toMatch(/password_?hash/i);
      expect(all).not.toMatch(/token_?hash/i);
      expect(all).not.toContain(PASSWORD);
      const sessions = await t.db.selectFrom("sessions").select("token_hash").execute();
      for (const s of sessions) expect(all).not.toContain(s.token_hash.toString("hex"));
    });
  });
});
