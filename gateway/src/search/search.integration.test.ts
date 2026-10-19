import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import { MemoryCredentialStore } from "../credentials/store.js";
import { insertApiKey } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { upsertRule } from "../db/permissions.js";
import { insertServer, listServers } from "../db/servers.js";
import { createUser } from "../db/users.js";
import { GatewayMetrics } from "../metrics/metrics.js";
import { PERMISSIVE_POLICY } from "../security/ssrf.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { testAuthConfig } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { HealthChecker } from "../upstreams/health.js";
import { UpstreamRegistry } from "../upstreams/registry.js";
import { ToolRouter } from "../upstreams/router.js";
import type { SearchMode } from "./surface.js";
import { ToolSurface } from "./surface.js";

// The fake upstream always adds `fail` and `big` helper tools; they are not under test.
const real = (n: string) => !/__(fail|big)$/.test(n);
const body = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const json = (r: CallToolResult) => JSON.parse(body(r));

/**
 * Search-then-execute over the real protocol: real MCP clients talk to three
 * gateways (search off / on / auto) that share one database and two upstreams.
 */
describe.skipIf(!hasTestDb)("search-then-execute (MCP)", () => {
  const credentials = new MemoryCredentialStore();
  let t: TestDatabase;
  let registry: UpstreamRegistry;
  let shop: FakeUpstream;
  let docs: FakeUpstream;
  const servers: Server[] = [];
  const urls = {} as Record<SearchMode, string>;
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let metrics: GatewayMetrics;

  const listen = async (mode: SearchMode, autoThreshold: number, health: HealthChecker) => {
    const router = new ToolRouter(t.db, registry, metrics);
    const http = createApp({
      db: t.db,
      credentials,
      registry,
      health,
      router,
      metrics,
      tools: new ToolSurface(router, { mode, autoThreshold }, metrics),
      config: { auth: testAuthConfig, trustProxyHops: 0 },
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => http.once("listening", resolve));
    servers.push(http);
    urls[mode] = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  };

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
    registry = new UpstreamRegistry(credentials, {
      maxResultBytes: 100_000,
      ssrf: PERMISSIVE_POLICY,
    });
    const health = new HealthChecker(t.db, registry, { intervalMs: 60_000, listTimeoutMs: 5_000 });
    await health.checkAll();
    metrics = new GatewayMetrics(() => listServers(t.db));

    for (const [name, role] of [
      ["admin", "admin"],
      ["member", "member"],
    ] as const) {
      const user = await createUser(t.db, { email: `${name}@example.com`, name, role });
      const k = generateApiKey();
      await insertApiKey(t.db, { userId: user.id, name: "k", ...k });
      keys[name] = k.key;
      ids[name] = user.id;
    }
    // 7 tools in all (4 shop incl. helpers + 3 docs incl. helpers). Auto switches above 5.
    await listen("off", 5, health);
    await listen("on", 5, health);
    await listen("auto", 5, health);
  });

  afterEach(async () => {
    await t.db.deleteFrom("tool_permissions").execute();
    await t.db.deleteFrom("audit_log").execute();
  });

  afterAll(async () => {
    await registry?.closeAll();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
    await Promise.all([shop?.close(), docs?.close()]);
    await t?.drop();
  });

  async function connect(mode: SearchMode, who: string, query = "") {
    const client = new Client({ name: "search-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${urls[mode]}/mcp${query}`), {
        requestInit: { headers: { Authorization: `Bearer ${keys[who]}` } },
      }),
    );
    return client;
  }
  const withClient = async <T>(
    mode: SearchMode,
    who: string,
    query: string,
    fn: (c: Client) => Promise<T>,
  ) => {
    const c = await connect(mode, who, query);
    try {
      return await fn(c);
    } finally {
      await c.close();
    }
  };
  const listNames = (mode: SearchMode, who: string, query = "") =>
    withClient(mode, who, query, async (c) =>
      (await c.listTools()).tools.map((x) => x.name).sort(),
    );
  const call = (mode: SearchMode, who: string, name: string, args: Record<string, unknown>) =>
    withClient(
      mode,
      who,
      "",
      async (c) => (await c.callTool({ name, arguments: args })) as CallToolResult,
    );

  describe("which tools a client sees", () => {
    it("lists every tool when search mode is off", async () => {
      const names = await listNames("off", "admin");
      expect(names.filter(real)).toEqual([
        "docs__search",
        "shop__list_orders",
        "shop__update_order_status",
      ]);
    });

    it("lists only search_tools and call_tool when search mode is on", async () => {
      expect(await listNames("on", "admin")).toEqual(["call_tool", "search_tools"]);
    });

    it("lets a client override the mode in either direction with ?mode=", async () => {
      expect(await listNames("off", "admin", "?mode=search")).toEqual([
        "call_tool",
        "search_tools",
      ]);
      expect((await listNames("on", "admin", "?mode=full")).filter(real)).toHaveLength(3);
    });

    it("rejects an unknown ?mode= instead of silently ignoring a typo", async () => {
      const res = await fetch(`${urls.off}/mcp?mode=serach`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys.admin}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(400);
    });

    it("in auto mode switches on the number of tools the caller can see", async () => {
      expect(await listNames("auto", "admin")).toEqual(["call_tool", "search_tools"]);
      // Hide the whole shop server from members: they are left with 3 tools, under the threshold.
      await upsertRule(t.db, {
        role: "member",
        serverSlug: "shop",
        toolName: null,
        effect: "deny",
        createdBy: null,
      });
      expect((await listNames("auto", "member")).filter(real)).toEqual(["docs__search"]);
    });
  });

  describe("search_tools", () => {
    it("finds a tool and returns its exact name and input schema", async () => {
      const r = await call("on", "admin", "search_tools", { query: "update order status" });
      expect(r.isError).toBeFalsy();
      const found = json(r);
      expect(found.results[0].name).toBe("shop__update_order_status");
      expect(found.results[0].server).toBe("shop");
      expect(found.results[0].inputSchema).toMatchObject({ type: "object" });
    });

    it("lists servers for an empty query", async () => {
      const r = await call("on", "admin", "search_tools", {});
      expect(
        json(r)
          .servers.map((s: { server: string }) => s.server)
          .sort(),
      ).toEqual(["docs", "shop"]);
    });

    it("never reveals a tool the caller may not use", async () => {
      await upsertRule(t.db, {
        role: "member",
        serverSlug: "shop",
        toolName: "update_order_status",
        effect: "deny",
        createdBy: null,
      });
      const asMember = json(
        await call("on", "member", "search_tools", { query: "update order status" }),
      );
      expect(JSON.stringify(asMember)).not.toContain("update_order_status");
      const asAdmin = json(
        await call("on", "admin", "search_tools", { query: "update order status" }),
      );
      expect(asAdmin.results[0].name).toBe("shop__update_order_status");
    });

    it("is audited with its query (no server) and counted in the metrics", async () => {
      await call("on", "admin", "search_tools", { query: "orders" });
      const rows = await queryAudit(t.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool_name: "search_tools",
        server_slug: null,
        outcome: "success",
        source: "mcp",
      });
      expect(rows[0]!.detail).toMatch(/^query: "orders" · \d+ matches?$/);
      const text = await (await fetch(`${urls.on}/metrics`)).text();
      expect(text).toMatch(/mcp_gateway_search_tools_total\{source="mcp"\} [1-9]/);
    });

    it("answers bad arguments with an error result, not a protocol failure", async () => {
      const r = await call("on", "admin", "search_tools", { limit: 1000 });
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/Invalid arguments for search_tools/);
    });
  });

  describe("call_tool", () => {
    it("runs the tool and audits it under the real server and tool name", async () => {
      const r = await call("on", "member", "call_tool", {
        name: "shop__list_orders",
        arguments: {},
      });
      expect(r.isError).toBeFalsy();
      const [row, ...rest] = await queryAudit(t.db);
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        tool_name: "shop__list_orders",
        server_slug: "shop",
        source: "mcp",
        outcome: "success",
        user_id: ids.member,
      });
    });

    it("is denied, and audited as denied under the real name, when the caller lacks permission", async () => {
      await upsertRule(t.db, {
        role: "member",
        serverSlug: "shop",
        toolName: "update_order_status",
        effect: "deny",
        createdBy: null,
      });
      const r = await call("on", "member", "call_tool", {
        name: "shop__update_order_status",
        arguments: {},
      });
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/permission/);
      const [row] = await queryAudit(t.db);
      expect(row).toMatchObject({ tool_name: "shop__update_order_status", outcome: "denied" });
    });

    it("tells the model to search when the name is unknown", async () => {
      const r = await call("on", "admin", "call_tool", { name: "shop__nope", arguments: {} });
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/Unknown tool 'shop__nope'.*search_tools/);
      const [row] = await queryAudit(t.db);
      expect(row).toMatchObject({ tool_name: "shop__nope", outcome: "rejected" });
    });

    it("will not run a meta-tool through itself", async () => {
      const r = await call("on", "admin", "call_tool", { name: "call_tool", arguments: {} });
      expect(r.isError).toBe(true);
      expect(await queryAudit(t.db)).toHaveLength(0);
    });

    it("rejects malformed arguments before touching an upstream", async () => {
      const r = await call("on", "admin", "call_tool", { arguments: {} });
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/Invalid arguments for call_tool/);
      expect(await queryAudit(t.db)).toHaveLength(0);
    });

    it("keeps working by real name in search mode, with the same checks", async () => {
      const r = await call("on", "admin", "shop__list_orders", {});
      expect(r.isError).toBeFalsy();
      expect((await queryAudit(t.db))[0]).toMatchObject({ tool_name: "shop__list_orders" });
    });

    it("is labelled by the real server and tool in the metrics", async () => {
      await call("on", "admin", "call_tool", { name: "shop__list_orders", arguments: {} });
      const text = await (await fetch(`${urls.on}/metrics`)).text();
      expect(text).toMatch(
        /mcp_gateway_tool_calls_total\{server="shop",tool="list_orders",source="mcp",outcome="success"\} [1-9]/,
      );
      expect(text).not.toContain('tool="call_tool"');
    });
  });
});
