import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "../crypto/apiKeys.js";
import { MemoryCredentialStore } from "../credentials/store.js";
import { insertApiKey, type Principal } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { getServer, insertServer, updateServer } from "../db/servers.js";
import { createUser } from "../db/users.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { HealthChecker } from "./health.js";
import { UpstreamRegistry } from "./registry.js";
import { ToolRouter, type CallContext } from "./router.js";
import { PERMISSIVE_POLICY } from "../security/ssrf.js";

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe.skipIf(!hasTestDb)("ToolRouter", () => {
  const credentials = new MemoryCredentialStore();
  let t: TestDatabase;
  let registry: UpstreamRegistry;
  let health: HealthChecker;
  let router: ToolRouter;
  let ctx: CallContext;
  let storeA: FakeUpstream;
  let storeB: FakeUpstream;
  let ids: Record<string, string>;

  beforeAll(async () => {
    t = await createTestDatabase();
    const user = await createUser(t.db, { email: "a@example.com", name: "A", role: "member" });
    const key = await insertApiKey(t.db, { userId: user.id, name: "k", ...generateApiKey() });
    const principal: Principal = {
      userId: user.id,
      email: user.email,
      role: "member",
      authMethod: "api_key",
      keyId: key.id,
      sessionId: null,
    };
    ctx = { principal, source: "mcp" };
  });

  beforeEach(async () => {
    registry = new UpstreamRegistry(credentials, {
      maxResultBytes: 100_000,
      ssrf: PERMISSIVE_POLICY,
    });
    health = new HealthChecker(t.db, registry, { intervalMs: 60_000, listTimeoutMs: 300 });
    router = new ToolRouter(t.db, registry);
    // Two WooCommerce-shaped servers exposing the same tool name.
    storeA = await startFakeUpstream({ toolNames: ["list_products"] });
    storeB = await startFakeUpstream({ toolNames: ["list_products"] });
    ids = {};
    for (const [slug, url] of [
      ["store-a", storeA.url],
      ["store-b", storeB.url],
    ]) {
      const id = randomUUID();
      await insertServer(t.db, { id, slug, name: slug.toUpperCase(), url, timeout_ms: 400 });
      ids[slug] = id;
    }
    await health.checkAll();
  });

  afterEach(async () => {
    await registry.closeAll();
    await Promise.all([storeA.close(), storeB.close()]);
    await t.db.deleteFrom("mcp_servers").execute();
    await t.db.deleteFrom("audit_log").execute();
  });

  afterAll(async () => {
    await t?.drop();
  });

  async function lastAudit() {
    const [entry] = await queryAudit(t.db, { limit: 1 });
    return entry;
  }

  it("lists namespaced tools from every connected server, with collisions kept apart", async () => {
    const names = (await router.listTools(ctx.principal)).map((tool) => tool.name);
    expect(names).toContain("store-a__list_products");
    expect(names).toContain("store-b__list_products");
    expect(names).toContain("store-a__fail");
  });

  it("routes same-named tools to the right upstream and audits the success", async () => {
    const result = await router.callTool(ctx, "store-b__list_products", { value: "x" });
    expect(text(result)).toBe("list_products:x");
    expect(storeB.calls.list_products).toBe(1);
    expect(storeA.calls.list_products).toBeUndefined();

    const entry = await lastAudit();
    expect(entry).toMatchObject({
      user_id: ctx.principal.userId,
      user_email: "a@example.com",
      api_key_id: ctx.principal.keyId,
      source: "mcp",
      server_slug: "store-b",
      tool_name: "store-b__list_products",
      outcome: "success",
      error: null,
    });
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("passes a tool error through and audits it as tool_error", async () => {
    const result = await router.callTool(ctx, "store-a__fail", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Order 999 not found");
    expect(await lastAudit()).toMatchObject({
      outcome: "tool_error",
      error: "Order 999 not found",
    });
  });

  it("rejects unknown tools and audits the rejection", async () => {
    const result = await router.callTool(ctx, "nope__list_products", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unknown tool 'nope__list_products'/);
    expect(await lastAudit()).toMatchObject({ outcome: "rejected", server_slug: null });
  });

  it("hides a disabled server's tools and rejects direct calls to them", async () => {
    await updateServer(t.db, ids["store-a"], { enabled: false });
    const names = (await router.listTools(ctx.principal)).map((tool) => tool.name);
    expect(names.some((n) => n.startsWith("store-a__"))).toBe(false);
    expect(names).toContain("store-b__list_products");

    const result = await router.callTool(ctx, "store-a__list_products", {});
    expect(text(result)).toBe("Server 'store-a' is disabled");
    expect(storeA.calls.list_products).toBeUndefined();
    expect(await lastAudit()).toMatchObject({ outcome: "rejected", server_slug: "store-a" });
  });

  it("times out a hanging upstream, audits timeout, and keeps the other server working", async () => {
    storeA.behavior = "hang";
    const startedAt = Date.now();
    const [slow, fast] = await Promise.all([
      router.callTool(ctx, "store-a__list_products", {}),
      router.callTool(ctx, "store-b__list_products", {}),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(text(slow)).toMatch(/'store-a' timed out after 400ms/);
    expect(fast.isError).toBeFalsy();
    const outcomes = (await queryAudit(t.db)).map((e) => [e.server_slug, e.outcome]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ["store-a", "timeout"],
        ["store-b", "success"],
      ]),
    );
  });

  it("reports a dead upstream as unreachable, marks it on the dashboard, and hides its tools", async () => {
    await storeA.close();
    const result = await router.callTool(ctx, "store-a__list_products", {});
    expect(text(result)).toMatch(/'store-a' is unreachable \(ECONNREFUSED\)/);
    expect(await lastAudit()).toMatchObject({ outcome: "unreachable", server_slug: "store-a" });
    expect((await getServer(t.db, ids["store-a"]))?.status).toBe("unreachable");

    const names = (await router.listTools(ctx.principal)).map((tool) => tool.name);
    expect(names.some((n) => n.startsWith("store-a__"))).toBe(false);
    expect(names).toContain("store-b__list_products");
  });

  it("attributes chat calls to the same user with source=chat", async () => {
    await router.callTool({ ...ctx, source: "chat" }, "store-a__list_products", {});
    expect(await lastAudit()).toMatchObject({ source: "chat", user_id: ctx.principal.userId });
  });
});
