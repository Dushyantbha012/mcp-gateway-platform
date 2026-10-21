import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, checkUntilConnected, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { insertServer } from "../db/servers.js";

describe.skipIf(!hasTestDb)("/api/permissions", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let shop: FakeUpstream;
  let admin: Awaited<ReturnType<typeof userWithKey>>;
  let member: Awaited<ReturnType<typeof userWithKey>>;
  let other: Awaited<ReturnType<typeof userWithKey>>;

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db);
    shop = await startFakeUpstream({ toolNames: ["list_orders", "update_order_status"] });
    await insertServer(t.db, { slug: "shop", name: "Shop", url: shop.url, timeout_ms: 2_000 });
    await checkUntilConnected(gw);
    admin = await userWithKey(t.db, "admin@example.com", "admin");
    member = await userWithKey(t.db, "member@example.com", "member");
    other = await userWithKey(t.db, "other@example.com", "member");
  });
  afterEach(async () => {
    await t.db.deleteFrom("tool_permissions").execute();
  });
  afterAll(async () => {
    await gw?.registry.closeAll();
    await shop?.close();
    await t?.drop();
  });

  const as = (who: { key: string }) => ({
    get: (p: string) => request(gw.app).get(p).set("Authorization", `Bearer ${who.key}`),
    put: (p: string, body: object) =>
      request(gw.app).put(p).set("Authorization", `Bearer ${who.key}`).send(body),
    delete: (p: string) => request(gw.app).delete(p).set("Authorization", `Bearer ${who.key}`),
  });
  const denyUpdate = {
    role: "member",
    serverSlug: "shop",
    toolName: "update_order_status",
    effect: "deny",
  };

  it("is admin-only on every route, and unauthenticated callers get 401", async () => {
    const m = as(member);
    expect((await m.get("/api/permissions")).status).toBe(403);
    expect((await m.put("/api/permissions", denyUpdate)).status).toBe(403);
    expect((await m.delete("/api/permissions/00000000-0000-4000-8000-000000000000")).status).toBe(
      403,
    );
    expect((await m.get(`/api/permissions/effective?userId=${member.user.id}`)).status).toBe(403);
    expect((await request(gw.app).get("/api/permissions")).status).toBe(401);
  });

  it("creates a rule, lists it with who it targets, and deletes it", async () => {
    const a = as(admin);
    const put = await a.put("/api/permissions", denyUpdate);
    expect(put.status).toBe(200);
    const list = await a.get("/api/permissions");
    expect(list.body).toEqual([
      expect.objectContaining({
        id: put.body.id,
        subject: { type: "role", role: "member" },
        serverSlug: "shop",
        toolName: "update_order_status",
        effect: "deny",
      }),
    ]);
    expect((await a.delete(`/api/permissions/${put.body.id}`)).status).toBe(204);
    expect((await a.get("/api/permissions")).body).toEqual([]);
    expect((await a.delete(`/api/permissions/${put.body.id}`)).status).toBe(404);
  });

  it("putting the same target again changes the effect instead of adding a row", async () => {
    const a = as(admin);
    const first = await a.put("/api/permissions", denyUpdate);
    const second = await a.put("/api/permissions", { ...denyUpdate, effect: "allow" });
    expect(second.body.id).toBe(first.body.id);
    const list = (await a.get("/api/permissions")).body as { effect: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].effect).toBe("allow");
  });

  it("lists a user rule with the user's email", async () => {
    const a = as(admin);
    await a.put("/api/permissions", {
      userId: member.user.id,
      serverSlug: "shop",
      toolName: null,
      effect: "deny",
    });
    expect((await a.get("/api/permissions")).body[0]).toMatchObject({
      subject: { type: "user", userId: member.user.id, email: "member@example.com" },
      toolName: null,
    });
  });

  it.each([
    ["both role and userId", () => ({ ...denyUpdate, userId: member.user.id })],
    ["neither role nor userId", () => ({ serverSlug: "shop", toolName: null, effect: "deny" })],
    ["the admin role", () => ({ ...denyUpdate, role: "admin" })],
    ["an unknown server", () => ({ ...denyUpdate, serverSlug: "nope" })],
    [
      "an unknown user",
      () => ({
        userId: "00000000-0000-4000-8000-000000000000",
        serverSlug: "shop",
        toolName: null,
        effect: "deny",
      }),
    ],
    [
      "an admin user",
      () => ({ userId: admin.user.id, serverSlug: "shop", toolName: null, effect: "deny" }),
    ],
    ["a bad effect", () => ({ ...denyUpdate, effect: "maybe" })],
    ["an empty tool name", () => ({ ...denyUpdate, toolName: "" })],
    ["an unknown field", () => ({ ...denyUpdate, extra: 1 })],
    [
      "a non-uuid userId",
      () => ({ userId: "x", serverSlug: "shop", toolName: null, effect: "deny" }),
    ],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await as(admin).put("/api/permissions", body());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("deleting with a malformed id is a 404, not a server error", async () => {
    expect((await as(admin).delete("/api/permissions/not-a-uuid")).status).toBe(404);
  });

  it("a rule takes effect on the member's own /api/tools at once, and its removal undoes it", async () => {
    const a = as(admin);
    const tools = async () =>
      ((await as(member).get("/api/tools")).body as { name: string }[]).map((x) => x.name);
    expect(await tools()).toContain("shop__update_order_status");
    const { body } = await a.put("/api/permissions", denyUpdate);
    expect(await tools()).not.toContain("shop__update_order_status");
    expect(await tools()).toContain("shop__list_orders");
    await a.delete(`/api/permissions/${body.id}`);
    expect(await tools()).toContain("shop__update_order_status");
  });

  it("effective view explains each tool for a user, using the same decision as the gateway", async () => {
    const a = as(admin);
    await a.put("/api/permissions", denyUpdate);
    await a.put("/api/permissions", {
      userId: other.user.id,
      serverSlug: "shop",
      toolName: "update_order_status",
      effect: "allow",
    });
    const view = async (id: string) =>
      (
        (await a.get(`/api/permissions/effective?userId=${id}`)).body as {
          name: string;
          allowed: boolean;
          reason: string;
        }[]
      ).filter((x) => /__(list_orders|update_order_status)$/.test(x.name));

    expect(await view(member.user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "shop__update_order_status",
          allowed: false,
          reason: "rule",
        }),
        expect.objectContaining({ name: "shop__list_orders", allowed: true, reason: "default" }),
      ]),
    );
    expect(await view(other.user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "shop__update_order_status",
          allowed: true,
          reason: "rule",
        }),
      ]),
    );
    expect((await view(admin.user.id)).every((x) => x.allowed && x.reason === "admin")).toBe(true);
    // The role as a whole: only role rules, never anyone's user rules.
    const roleView = (await a.get("/api/permissions/effective?role=member")).body as {
      name: string;
      allowed: boolean;
    }[];
    expect(roleView.find((x) => x.name === "shop__update_order_status")?.allowed).toBe(false);
    const asAdminRole = (await a.get("/api/permissions/effective?role=admin")).body as {
      allowed: boolean;
    }[];
    expect(asAdminRole.every((x) => x.allowed)).toBe(true);
    expect((await a.get("/api/permissions/effective?userId=not-a-uuid")).status).toBe(400);
    expect(
      (await a.get("/api/permissions/effective?userId=00000000-0000-4000-8000-000000000000"))
        .status,
    ).toBe(404);
    expect((await a.get("/api/permissions/effective")).status).toBe(400);
    expect(
      (await a.get(`/api/permissions/effective?role=member&userId=${other.user.id}`)).status,
    ).toBe(400);
  });

  it("removing a server removes its rules, so a new server with that slug starts clean", async () => {
    const a = as(admin);
    const extra = await startFakeUpstream({ toolNames: ["x"] });
    try {
      const add = await request(gw.app)
        .post("/api/servers")
        .set("Authorization", `Bearer ${admin.key}`)
        .send({ slug: "temp", name: "Temp", url: extra.url });
      expect(add.status).toBe(201);
      await a.put("/api/permissions", {
        role: "member",
        serverSlug: "temp",
        toolName: null,
        effect: "deny",
      });
      await request(gw.app)
        .delete(`/api/servers/${add.body.id}`)
        .set("Authorization", `Bearer ${admin.key}`);
      expect((await a.get("/api/permissions")).body).toEqual([]);
    } finally {
      await extra.close();
    }
  });

  it("renaming a server's slug moves its rules with it", async () => {
    const a = as(admin);
    const extra = await startFakeUpstream({ toolNames: ["x"] });
    try {
      const add = await request(gw.app)
        .post("/api/servers")
        .set("Authorization", `Bearer ${admin.key}`)
        .send({ slug: "old-name", name: "Old", url: extra.url });
      await a.put("/api/permissions", {
        role: "member",
        serverSlug: "old-name",
        toolName: null,
        effect: "deny",
      });
      const patch = await request(gw.app)
        .patch(`/api/servers/${add.body.id}`)
        .set("Authorization", `Bearer ${admin.key}`)
        .send({ slug: "new-name" });
      expect(patch.status).toBe(200);
      expect((await a.get("/api/permissions")).body[0]).toMatchObject({ serverSlug: "new-name" });
      await request(gw.app)
        .delete(`/api/servers/${add.body.id}`)
        .set("Authorization", `Bearer ${admin.key}`);
    } finally {
      await extra.close();
    }
  });
});
