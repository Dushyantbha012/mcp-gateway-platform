import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import { createSecretBox } from "../crypto/secretBox.js";
import { insertApiKey } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { deleteRule, upsertRule } from "../db/permissions.js";
import { insertServer } from "../db/servers.js";
import { createUser } from "../db/users.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { testAuthConfig } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { HealthChecker } from "../upstreams/health.js";
import { UpstreamRegistry } from "../upstreams/registry.js";
import { ToolRouter } from "../upstreams/router.js";
import { PERMISSIVE_POLICY } from "../security/ssrf.js";

// The fake upstream always adds `fail` and `big` helper tools; they are not under test.
const real = (n: string) => !/__(fail|big)$/.test(n);
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

/**
 * Tool permissions over the real protocol: real MCP clients for an admin and
 * two members talk to the gateway over HTTP, in front of two fake upstreams.
 */
describe.skipIf(!hasTestDb)("tool permissions", () => {
  const box = createSecretBox(randomBytes(32).toString("base64"));
  let t: TestDatabase;
  let registry: UpstreamRegistry;
  let http: Server;
  let baseUrl: string;
  let shop: FakeUpstream;
  let docs: FakeUpstream;
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const created: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    shop = await startFakeUpstream({ toolNames: ["list_orders", "update_order_status"] });
    docs = await startFakeUpstream({ toolNames: ["search"] });
    for (const [slug, f] of [
      ["shop", shop],
      ["docs", docs],
    ] as const) {
      await insertServer(t.db, { slug, name: slug, url: f.url, timeout_ms: 5_000 });
    }
    registry = new UpstreamRegistry(box, { maxResultBytes: 100_000, ssrf: PERMISSIVE_POLICY });
    const health = new HealthChecker(t.db, registry, { intervalMs: 60_000, listTimeoutMs: 5_000 });
    await health.checkAll();

    for (const [name, role] of [
      ["admin", "admin"],
      ["b", "member"],
      ["c", "member"],
    ] as const) {
      const user = await createUser(t.db, { email: `${name}@example.com`, name, role });
      const k = generateApiKey();
      await insertApiKey(t.db, { userId: user.id, name: "k", ...k });
      keys[name] = k.key;
      ids[name] = user.id;
    }
    http = createApp({
      db: t.db,
      box,
      registry,
      health,
      router: new ToolRouter(t.db, registry),
      config: { auth: testAuthConfig, trustProxyHops: 0 },
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => http.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await t.db.deleteFrom("tool_permissions").execute();
    await t.db.deleteFrom("audit_log").execute();
    shop.calls = {};
  });

  afterAll(async () => {
    await registry?.closeAll();
    http?.closeAllConnections();
    await new Promise((resolve) => http?.close(resolve));
    await Promise.all([shop?.close(), docs?.close()]);
    await t?.drop();
  });
  void created;

  async function connect(who: string) {
    const client = new Client({ name: "perm-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${keys[who]}` } },
      }),
    );
    return client;
  }
  const names = async (who: string) => {
    const c = await connect(who);
    try {
      return (await c.listTools()).tools
        .map((x) => x.name)
        .filter(real)
        .sort();
    } finally {
      await c.close();
    }
  };
  const call = async (who: string, name: string) => {
    const c = await connect(who);
    try {
      return (await c.callTool({ name, arguments: {} })) as CallToolResult;
    } finally {
      await c.close();
    }
  };
  const rule = (effect: "allow" | "deny", over: Partial<Parameters<typeof upsertRule>[1]> = {}) =>
    upsertRule(t.db, {
      role: "member",
      serverSlug: "shop",
      toolName: "update_order_status",
      effect,
      createdBy: null,
      ...over,
    });

  const all = ["docs__search", "shop__list_orders", "shop__update_order_status"];

  it("with no rules, everyone sees every tool (allow by default)", async () => {
    expect(await names("b")).toEqual(all);
    expect(await names("admin")).toEqual(all);
  });

  it("a denied tool is hidden from members' tools/list, others untouched", async () => {
    await rule("deny");
    expect(await names("b")).toEqual(["docs__search", "shop__list_orders"]);
    expect(await names("c")).toEqual(["docs__search", "shop__list_orders"]);
  });

  it("admins are unaffected by member rules, and by rules aimed at admin", async () => {
    await rule("deny");
    await rule("deny", { role: "admin", toolName: null });
    expect(await names("admin")).toEqual(all);
    const res = await call("admin", "shop__update_order_status");
    expect(res.isError).toBeFalsy();
  });

  it("a direct call to a denied tool is refused, audited as denied, and never reaches the upstream", async () => {
    await rule("deny");
    const res = await call("b", "shop__update_order_status");
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("You don't have permission to use 'shop__update_order_status'");
    expect(shop.calls.update_order_status).toBeUndefined();

    const [entry] = await queryAudit(t.db, { limit: 1 });
    expect(entry).toMatchObject({
      user_email: "b@example.com",
      source: "mcp",
      server_slug: "shop",
      tool_name: "shop__update_order_status",
      outcome: "denied",
    });
  });

  it("an allowed tool on the same server still works and is audited as success", async () => {
    await rule("deny");
    const res = await call("b", "shop__list_orders");
    expect(res.isError).toBeFalsy();
    expect(shop.calls.list_orders).toBe(1);
    const [entry] = await queryAudit(t.db, { limit: 1 });
    expect(entry?.outcome).toBe("success");
  });

  it("a server-wide deny hides every tool of that server and leaves the others", async () => {
    await rule("deny", { toolName: null });
    expect(await names("b")).toEqual(["docs__search"]);
    expect((await call("b", "shop__list_orders")).isError).toBe(true);
  });

  it("a user rule overrides the role rule for that person only", async () => {
    await rule("deny");
    await rule("allow", { role: undefined, userId: ids.b });
    expect(await names("b")).toEqual(all);
    expect(await names("c")).toEqual(["docs__search", "shop__list_orders"]);
    expect((await call("b", "shop__update_order_status")).isError).toBeFalsy();
    expect((await call("c", "shop__update_order_status")).isError).toBe(true);
  });

  it("a rule aimed at one user leaves other members alone", async () => {
    await rule("deny", { role: undefined, userId: ids.c });
    expect(await names("b")).toEqual(all);
    expect(await names("c")).toEqual(["docs__search", "shop__list_orders"]);
  });

  it("changes apply on the very next request, in both directions", async () => {
    const client = await connect("b"); // one long-lived client
    const visible = async () =>
      (await client.listTools()).tools.map((x) => x.name).filter(real).length;
    expect(await visible()).toBe(3);
    const r = await rule("deny");
    expect(await visible()).toBe(2);
    // Holding the old list doesn't help: the call is checked again.
    const stale = (await client.callTool({
      name: "shop__update_order_status",
      arguments: {},
    })) as CallToolResult;
    expect(stale.isError).toBe(true);
    await deleteRule(t.db, r.id);
    expect(await visible()).toBe(3);
    await client.close();
  });

  it("/api/tools shows the caller's own filtered view", async () => {
    await rule("deny");
    const get = async (who: string) =>
      (
        (await (
          await fetch(`${baseUrl}/api/tools`, { headers: { Authorization: `Bearer ${keys[who]}` } })
        ).json()) as { name: string }[]
      )
        .map((x) => x.name)
        .filter(real)
        .sort();
    expect(await get("b")).toEqual(["docs__search", "shop__list_orders"]);
    expect(await get("admin")).toEqual(all);
  });

  it("an unknown tool is still 'rejected', not 'denied'", async () => {
    await rule("deny", { toolName: null });
    const res = await call("b", "nope__nothing");
    expect(res.isError).toBe(true);
    const [entry] = await queryAudit(t.db, { limit: 1 });
    expect(entry?.outcome).toBe("rejected");
  });
});
