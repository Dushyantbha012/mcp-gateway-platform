import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getServerBySlug } from "../db/servers.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

/** Where upstream credentials live: the credential store, never the database. */
describe.skipIf(!hasTestDb)("upstream credentials in the credential store", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let admin: Awaited<ReturnType<typeof userWithKey>>;
  const fakes: FakeUpstream[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db);
    admin = await userWithKey(t.db, "admin@example.com", "admin");
  });
  afterEach(async () => {
    await gw.registry.closeAll();
    await Promise.all(fakes.splice(0).map((f) => f.close()));
    for (const s of await t.db.selectFrom("mcp_servers").select("id").execute()) {
      await gw.credentials.delete(s.id);
    }
    await t.db.deleteFrom("mcp_servers").execute();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const api = (method: "post" | "patch" | "delete", path: string, body?: object) =>
    request(gw.app)[method](path).set("Authorization", `Bearer ${admin.key}`).send(body);

  async function create(slug: string, credential = "tok-1") {
    const f = await startFakeUpstream();
    fakes.push(f);
    const res = await api("post", "/api/servers", {
      slug,
      name: slug,
      url: f.url,
      authType: "bearer",
      credential,
    });
    expect(res.status).toBe(201);
    return { res, f, id: res.body.id as string };
  }

  it("creating a server stores the credential and only a flag in the row", async () => {
    const { res, f, id } = await create("alpha", "tok-created");
    expect((await gw.credentials.get(id))?.value).toBe("tok-created");
    const row = await getServerBySlug(t.db, "alpha");
    expect(row).toMatchObject({ has_credential: true });
    expect(Object.keys(row!)).not.toContain("credential_ciphertext");
    expect(JSON.stringify(row)).not.toContain("tok-created");
    expect(res.body.status).toBe("connected");
    expect(f.requests.every((h) => h.authorization === "Bearer tok-created")).toBe(true);
  });

  it("rotating the credential applies at once and sends the new one", async () => {
    const { f, id } = await create("rot", "old");
    f.requests.length = 0;
    expect((await api("patch", `/api/servers/${id}`, { credential: "new" })).status).toBe(200);
    expect((await gw.credentials.get(id))?.value).toBe("new");
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((h) => h.authorization === "Bearer new")).toBe(true);
  });

  it("switching to no authentication removes the credential", async () => {
    const { id } = await create("noauth");
    const res = await api("patch", `/api/servers/${id}`, { authType: "none" });
    expect(res.status).toBe(200);
    expect(res.body.hasCredential).toBe(false);
    expect(await gw.credentials.get(id)).toBeNull();
  });

  it("deleting a server deletes its credential", async () => {
    const { id } = await create("gone");
    expect((await api("delete", `/api/servers/${id}`)).status).toBe(204);
    expect(await gw.credentials.get(id)).toBeNull();
  });

  it("a rejected create (duplicate slug) leaves no stray credential", async () => {
    await create("dup");
    const before = (await gw.credentials.list()).length;
    const f = await startFakeUpstream();
    fakes.push(f);
    const res = await api("post", "/api/servers", {
      slug: "dup",
      name: "again",
      url: f.url,
      authType: "bearer",
      credential: "second",
    });
    expect(res.status).toBe(409);
    expect((await gw.credentials.list()).length).toBe(before);
  });

  it("a rejected edit (slug taken) puts the previous credential back", async () => {
    await create("one", "keep-me");
    const { id } = await create("two", "mine-before");
    const res = await api("patch", `/api/servers/${id}`, {
      slug: "one",
      credential: "should-not-stick",
    });
    expect(res.status).toBe(409);
    expect((await gw.credentials.get(id))?.value).toBe("mine-before");
  });

  it("a server whose credential is missing is Unreachable with a clear reason", async () => {
    const { id } = await create("lost");
    await gw.credentials.delete(id);
    gw.registry.invalidate(id);
    const res = await api("post", `/api/servers/${id}/refresh`);
    expect(res.body.status).toBe("unreachable");
    expect(res.body.lastError).toMatch(/no stored credential/);
  });

  it("a credential store outage marks the server Unreachable without leaking anything", async () => {
    const { id } = await create("outage", "tok-secret");
    gw.registry.invalidate(id);
    const realGet = gw.credentials.get.bind(gw.credentials);
    gw.credentials.get = async () => {
      throw new Error("Kubernetes API unreachable (ECONNREFUSED)");
    };
    try {
      const res = await api("post", `/api/servers/${id}/refresh`);
      expect(res.body.status).toBe("unreachable");
      expect(res.body.lastError).toMatch(/credential unavailable/);
      expect(JSON.stringify(res.body)).not.toContain("tok-secret");
    } finally {
      gw.credentials.get = realGet;
    }
  });
});
