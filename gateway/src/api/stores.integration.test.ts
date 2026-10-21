import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { transitionStore } from "../db/stores.js";
import { buildTestApp, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { slugify } from "./stores.js";

describe("slugify", () => {
  it.each([
    ["Acme Inc.", "acme-inc"],
    ["  Globex  Corp ", "globex-corp"],
    ["42 Widgets", "widgets"],
    ["Café Olé", "cafe-ole"],
    ["a".repeat(40), "a".repeat(31)],
  ])("%s -> %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe.skipIf(!hasTestDb)("stores API", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let admin: Awaited<ReturnType<typeof userWithKey>>;
  let alice: Awaited<ReturnType<typeof userWithKey>>;
  let bob: Awaited<ReturnType<typeof userWithKey>>;

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db);
    admin = await userWithKey(t.db, "admin@example.com", "admin");
    alice = await userWithKey(t.db, "alice@example.com", "member");
    bob = await userWithKey(t.db, "bob@example.com", "member");
  });
  afterEach(async () => {
    await t.db.deleteFrom("stores").execute();
    await t.db.deleteFrom("mcp_servers").execute();
    await t.db.deleteFrom("audit_log").execute();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const as = (who: { key: string }) => ({
    get: (path: string) => request(gw.app).get(path).set("Authorization", `Bearer ${who.key}`),
    post: (path: string, body?: object) =>
      request(gw.app).post(path).set("Authorization", `Bearer ${who.key}`).send(body),
    delete: (path: string) =>
      request(gw.app).delete(path).set("Authorization", `Bearer ${who.key}`),
  });

  it("lets a member create a store, and a repeated request returns the same one", async () => {
    const first = await as(alice).post("/api/stores", { name: "Acme Inc" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      slug: "acme-inc",
      name: "Acme Inc",
      kind: "provisioned",
      status: "provisioning",
      owner: { email: "alice@example.com" },
      canManage: true,
    });
    const again = await as(alice).post("/api/stores", { name: "Acme Inc" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const row = await t.db.selectFrom("stores").selectAll().executeTakeFirstOrThrow();
    const minutes = (row.deadline_at!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it("shows every store to everyone, but only owners and admins may manage one", async () => {
    await as(alice).post("/api/stores", { name: "Acme" });
    const seenByBob = (await as(bob).get("/api/stores")).body;
    expect(seenByBob).toMatchObject({ enabled: true, maxPerUser: 2 });
    expect(seenByBob.stores).toHaveLength(1);
    expect(seenByBob.stores[0].canManage).toBe(false);
    expect((await as(admin).get("/api/stores")).body.stores[0].canManage).toBe(true);

    const id = seenByBob.stores[0].id;
    const denied = await as(bob).delete(`/api/stores/${id}`);
    expect(denied.status).toBe(403);
    const audit = await t.db
      .selectFrom("audit_log")
      .selectAll()
      .where("outcome", "=", "denied")
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        source: "dashboard",
        tool_name: "stores.delete",
        outcome: "denied",
        user_email: "bob@example.com",
      }),
    ]);
  });

  it("caps stores per user", async () => {
    expect((await as(bob).post("/api/stores", { name: "One" })).status).toBe(201);
    expect((await as(bob).post("/api/stores", { name: "Two" })).status).toBe(201);
    const third = await as(bob).post("/api/stores", { name: "Three" });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("store_limit");
    // Admins are capped too: the quota is about cluster capacity.
    expect((await as(admin).post("/api/stores", { name: "Admin one" })).status).toBe(201);
  });

  it("refuses names already taken by another user's store or by an MCP server", async () => {
    await as(alice).post("/api/stores", { name: "Acme" });
    expect((await as(bob).post("/api/stores", { name: "acme" })).status).toBe(409);
    await t.db
      .insertInto("mcp_servers")
      .values({ slug: "github", name: "GitHub", url: "https://x.io/mcp" })
      .execute();
    expect((await as(bob).post("/api/stores", { name: "GitHub" })).status).toBe(409);
  });

  it("validates names", async () => {
    expect((await as(bob).post("/api/stores", { name: "" })).status).toBe(400);
    expect((await as(bob).post("/api/stores", { name: "!!!" })).status).toBe(400);
    expect((await as(bob).post("/api/stores", { name: "x", slug: "Bad" })).status).toBe(400);
    expect((await as(bob).post("/api/stores", { name: "x", owner: "me" })).status).toBe(400);
    expect((await as(bob).post("/api/stores", { name: "Shop", slug: "my-shop" })).body.slug).toBe(
      "my-shop",
    );
  });

  it("marks a store for deletion, idempotently, and audits it", async () => {
    const { id } = (await as(alice).post("/api/stores", { name: "Acme" })).body;
    const first = await as(alice).delete(`/api/stores/${id}`);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: "deleting", step: "deleting" });
    expect((await as(alice).delete(`/api/stores/${id}`)).status).toBe(202);
    const audit = await t.db
      .selectFrom("audit_log")
      .select(["tool_name", "outcome", "server_slug"])
      .orderBy("ts")
      .execute();
    expect(audit).toEqual([
      { tool_name: "stores.create", outcome: "success", server_slug: "acme" },
      { tool_name: "stores.delete", outcome: "success", server_slug: "acme" },
    ]);
  });

  it("never deletes the default store", async () => {
    const { id } = await t.db
      .insertInto("stores")
      .values({ slug: "woocommerce", name: "Default", kind: "default", status: "ready" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const res = await as(admin).delete(`/api/stores/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("default_store");
  });

  it("retries only failed stores, resetting the deadline", async () => {
    const { id } = (await as(alice).post("/api/stores", { name: "Acme" })).body;
    expect((await as(alice).post(`/api/stores/${id}/retry`)).status).toBe(409);
    await transitionStore(t.db, id, ["provisioning"], {
      status: "failed",
      reason: "timed out",
      deadline_at: new Date(0),
    });
    const res = await as(alice).post(`/api/stores/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "provisioning", step: "retry", reason: null });
    const row = await t.db.selectFrom("stores").selectAll().executeTakeFirstOrThrow();
    expect(row.deadline_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("answers 404 for unknown or malformed ids", async () => {
    expect((await as(alice).get("/api/stores/nope")).status).toBe(404);
    expect(
      (await as(alice).delete("/api/stores/00000000-0000-0000-0000-000000000000")).status,
    ).toBe(404);
  });

  it("refuses to create stores when provisioning is off", async () => {
    const off = buildTestApp(
      t.db,
      {},
      { stores: { enabled: false, maxPerUser: 2, timeoutSeconds: 900 } },
    );
    const res = await request(off.app)
      .post("/api/stores")
      .set("Authorization", `Bearer ${alice.key}`)
      .send({ name: "Acme" });
    expect(res.status).toBe(503);
    const list = await request(off.app)
      .get("/api/stores")
      .set("Authorization", `Bearer ${alice.key}`);
    expect(list.body.enabled).toBe(false);
  });
});
