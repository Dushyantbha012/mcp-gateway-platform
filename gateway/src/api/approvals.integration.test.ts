import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "../crypto/apiKeys.js";
import { insertApiKey } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { insertServer } from "../db/servers.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, TEST_ORIGIN, userWithPassword } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

interface RpcResult {
  result?: { isError?: boolean; content: { text: string }[] };
}

describe.skipIf(!hasTestDb)("MCP write approvals", () => {
  let t: TestDatabase;
  let shop: FakeUpstream;
  let gw: ReturnType<typeof buildTestApp>;
  let key: string;
  let cookie: string;
  let otherCookie: string;
  let userId: string;

  const login = async (email: string, password: string) => {
    const res = await request(gw.app)
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ email, password });
    return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  };
  const mcp = (apiKey: string, name: string, args: object = {}) =>
    request(gw.app)
      .post("/mcp")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .then((r) => (r.body as RpcResult).result!);
  const browser = (c: string) => ({
    get: (p: string) => request(gw.app).get(p).set("Cookie", c).set("Origin", TEST_ORIGIN),
    post: (p: string) => request(gw.app).post(p).set("Cookie", c).set("Origin", TEST_ORIGIN),
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    shop = await startFakeUpstream({
      toolNames: ["list_orders", "create_product"],
      readOnlyTools: ["list_orders"],
    });
    await insertServer(t.db, { slug: "shop", name: "Shop", url: shop.url, timeout_ms: 2_000 });
    gw = buildTestApp(t.db, {}, { holdMcpWrites: true });
    await gw.health.checkAll();
    const u = await userWithPassword(t.db, "ann@example.com", "member", "correct horse battery");
    userId = u.user.id;
    key = generateApiKey().key;
    const g = generateApiKey();
    key = g.key;
    await insertApiKey(t.db, { userId, name: "k", ...g });
    cookie = await login("ann@example.com", "correct horse battery");
    await userWithPassword(t.db, "ben@example.com", "member", "correct horse battery");
    otherCookie = await login("ben@example.com", "correct horse battery");
  });
  afterAll(async () => {
    await gw?.registry.closeAll();
    await shop?.close();
    await t?.drop();
  });

  it("lets read-only tools through without asking", async () => {
    const r = await mcp(key, "shop__list_orders");
    expect(r.isError).toBeFalsy();
    expect(shop.calls.list_orders).toBe(1);
  });

  it("holds a write, shows it to its user only, and runs it once after approval", async () => {
    const args = { value: "mug", extra: { b: 1, a: 2 } };
    const held = await mcp(key, "shop__create_product", args);
    expect(held.isError).toBe(true);
    expect(held.content[0]!.text).toMatch(/must approve/);
    expect(shop.calls.create_product ?? 0).toBe(0);
    // Asking again doesn't pile up requests.
    await mcp(key, "shop__create_product", args);

    const pending = (await browser(cookie).get("/api/approvals")).body as {
      id: string;
      name: string;
      args: unknown;
      tool: { server: string; description: string } | null;
    }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: "shop__create_product", args });
    expect(pending[0]!.tool).toMatchObject({
      server: "shop",
      description: "[Shop] Fake create_product",
    });
    expect((await browser(otherCookie).get("/api/approvals")).body).toEqual([]);
    // Someone else can't decide it, and neither can the API key itself.
    expect(
      (await browser(otherCookie).post(`/api/approvals/${pending[0]!.id}/approve`)).status,
    ).toBe(404);
    const byKey = await request(gw.app)
      .post(`/api/approvals/${pending[0]!.id}/approve`)
      .set("Authorization", `Bearer ${key}`);
    expect(byKey.status).toBe(403);

    expect((await browser(cookie).post(`/api/approvals/${pending[0]!.id}/approve`)).status).toBe(
      204,
    );
    // Different arguments are a different request.
    const other = await mcp(key, "shop__create_product", { value: "other" });
    expect(other.isError).toBe(true);
    expect(shop.calls.create_product ?? 0).toBe(0);

    // Same arguments with the keys in another order: runs, exactly once.
    const ran = await mcp(key, "shop__create_product", { extra: { a: 2, b: 1 }, value: "mug" });
    expect(ran.isError).toBeFalsy();
    expect(shop.calls.create_product).toBe(1);
    const again = await mcp(key, "shop__create_product", args);
    expect(again.isError).toBe(true);
    expect(shop.calls.create_product).toBe(1);

    const rows = await queryAudit(t.db, { source: "mcp" });
    expect(rows.some((r) => r.outcome === "held" && r.tool_name === "shop__create_product")).toBe(
      true,
    );
  });

  it("tells the client when the user declined", async () => {
    await mcp(key, "shop__create_product", { value: "no" });
    const [p] = (await browser(cookie).get("/api/approvals")).body as {
      id: string;
      args: { value: string };
    }[];
    const target = p!;
    expect(target.args.value).toBe("no");
    expect((await browser(cookie).post(`/api/approvals/${target.id}/deny`)).status).toBe(204);
    const r = await mcp(key, "shop__create_product", { value: "no" });
    expect(r.content[0]!.text).toMatch(/declined/);
    const left = (await browser(cookie).get("/api/approvals")).body as {
      args: { value: string };
    }[];
    expect(left.some((a) => a.args.value === "no")).toBe(false);
  });
});
