import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { MemoryCredentialStore } from "../credentials/store.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import { insertApiKey } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { upsertRule } from "../db/permissions.js";
import { insertServer } from "../db/servers.js";
import { createUser } from "../db/users.js";
import { PERMISSIVE_POLICY } from "../security/ssrf.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { testAuthConfig } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { HealthChecker } from "../upstreams/health.js";
import { UpstreamRegistry } from "../upstreams/registry.js";
import { ToolRouter } from "../upstreams/router.js";

const real = (n: string) => !/__(fail|big)$/.test(n);
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

/**
 * The production default: members only get tools the upstream marks read-only
 * until an admin allows more. Real MCP clients over HTTP, one fake upstream
 * with a read tool and a write tool.
 */
describe.skipIf(!hasTestDb)("member read-only default", () => {
  const credentials = new MemoryCredentialStore();
  let t: TestDatabase;
  let registry: UpstreamRegistry;
  let http: Server;
  let baseUrl: string;
  let shop: FakeUpstream;
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    shop = await startFakeUpstream({
      toolNames: ["list_orders", "create_product"],
      readOnlyTools: ["list_orders"],
    });
    await insertServer(t.db, { slug: "shop", name: "shop", url: shop.url, timeout_ms: 5_000 });
    registry = new UpstreamRegistry(credentials, {
      maxResultBytes: 100_000,
      ssrf: PERMISSIVE_POLICY,
    });
    const health = new HealthChecker(t.db, registry, { intervalMs: 60_000, listTimeoutMs: 5_000 });
    await health.checkAll();
    for (const [name, role] of [
      ["admin", "admin"],
      ["a", "member"],
      ["b", "member"],
    ] as const) {
      const user = await createUser(t.db, { email: `${name}@example.com`, name, role });
      const k = generateApiKey();
      await insertApiKey(t.db, { userId: user.id, name: "k", ...k });
      keys[name] = k.key;
      ids[name] = user.id;
    }
    http = createApp({
      db: t.db,
      credentials,
      registry,
      health,
      router: new ToolRouter(t.db, registry, undefined, "readOnly"),
      config: { auth: testAuthConfig, trustProxyHops: 0 },
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => http.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await t.db.deleteFrom("tool_permissions").execute();
    await t.db.deleteFrom("audit_log").execute();
  });

  afterAll(async () => {
    await registry?.closeAll();
    http?.closeAllConnections();
    await new Promise((resolve) => http?.close(resolve));
    await shop?.close();
    await t?.drop();
  });

  async function withClient<T>(who: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "ro-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${keys[who]}` } },
      }),
    );
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  const names = (who: string) =>
    withClient(who, async (c) =>
      (await c.listTools()).tools
        .map((x) => x.name)
        .filter(real)
        .sort(),
    );

  it("a member sees only the read-only tool; an admin sees both", async () => {
    expect(await names("a")).toEqual(["shop__list_orders"]);
    expect(await names("admin")).toEqual(["shop__create_product", "shop__list_orders"]);
  });

  it("a direct call to the write tool is refused, audited as denied, and never runs", async () => {
    const res = await withClient(
      "b",
      (c) => c.callTool({ name: "shop__create_product", arguments: {} }) as Promise<CallToolResult>,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("You don't have permission to use 'shop__create_product'");
    expect(shop.calls.create_product).toBeUndefined();
    const [entry] = await queryAudit(t.db, { limit: 1 });
    expect(entry).toMatchObject({ user_email: "b@example.com", outcome: "denied" });
  });

  it("an Allow rule for one user grants the write tool to that user only", async () => {
    await upsertRule(t.db, {
      userId: ids.a!,
      serverSlug: "shop",
      toolName: "create_product",
      effect: "allow",
      createdBy: null,
    });
    expect(await names("a")).toEqual(["shop__create_product", "shop__list_orders"]);
    expect(await names("b")).toEqual(["shop__list_orders"]);
    const res = await withClient(
      "a",
      (c) => c.callTool({ name: "shop__create_product", arguments: {} }) as Promise<CallToolResult>,
    );
    expect(res.isError).toBeFalsy();
  });
});
