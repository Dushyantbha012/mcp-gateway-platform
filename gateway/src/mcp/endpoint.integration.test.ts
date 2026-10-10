import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import { createSecretBox } from "../crypto/secretBox.js";
import { insertApiKey, revokeApiKey } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { insertServer } from "../db/servers.js";
import { createUser } from "../db/users.js";
import { deadUrl, startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { HealthChecker } from "../upstreams/health.js";
import { UpstreamRegistry } from "../upstreams/registry.js";
import { ToolRouter } from "../upstreams/router.js";

/**
 * The exit criterion for Phase 3, over the real protocol: a real MCP SDK
 * client talks to the gateway over HTTP, and the gateway sits in front of one
 * healthy upstream, one that hangs, and one that's down.
 */
describe.skipIf(!hasTestDb)("gateway MCP endpoint", () => {
  const box = createSecretBox(randomBytes(32).toString("base64"));
  let t: TestDatabase;
  let registry: UpstreamRegistry;
  let http: Server;
  let baseUrl: string;
  let healthy: FakeUpstream;
  let hanging: FakeUpstream;
  let userKey: string;
  let userKeyId: string;
  let userId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    healthy = await startFakeUpstream({ toolNames: ["list_orders"] });
    hanging = await startFakeUpstream({ toolNames: ["slow_tool"] });

    const add = (slug: string, url: string, credential?: string) => {
      const id = randomUUID();
      return insertServer(t.db, {
        id,
        slug,
        name: slug,
        url,
        timeout_ms: 500,
        ...(credential
          ? { auth_type: "bearer" as const, credential_ciphertext: box.encrypt(credential, id) }
          : {}),
      });
    };
    await add("woocommerce", healthy.url, "upstream-token");
    await add("hanging", hanging.url);
    await add("dead", await deadUrl());

    registry = new UpstreamRegistry(box, { maxResultBytes: 100_000 });
    const health = new HealthChecker(t.db, registry, { intervalMs: 60_000, listTimeoutMs: 300 });
    await health.checkAll(); // hanging + dead -> unreachable; then make "hanging" look healthy
    await t.db
      .updateTable("mcp_servers")
      .set({
        status: "connected",
        tools_cache: JSON.stringify([{ name: "slow_tool", inputSchema: { type: "object" } }]),
      })
      .where("slug", "=", "hanging")
      .execute();
    hanging.behavior = "hang";

    const user = await createUser(t.db, { email: "b@example.com", name: "B", role: "member" });
    userId = user.id;
    const k = generateApiKey();
    userKey = k.key;
    userKeyId = (await insertApiKey(t.db, { userId: user.id, name: "cli", ...k })).id;

    const router = new ToolRouter(t.db, registry);
    http = createApp({ db: t.db, box, registry, health, router }).listen(0, "127.0.0.1");
    await new Promise((resolve) => http.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await registry?.closeAll();
    http?.closeAllConnections();
    await new Promise((resolve) => http?.close(resolve));
    await Promise.all([healthy?.close(), hanging?.close()]);
    await t?.drop();
  });

  /** The SDK reports the HTTP status on StreamableHTTPError.code. */
  async function expectStatus(promise: Promise<unknown>, status: number) {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamableHTTPError);
    expect((err as StreamableHTTPError).code).toBe(status);
    expect((err as Error).message).toMatch(/Missing, invalid or revoked API key/);
  }

  async function connect(key: string | null) {
    const client = new Client({ name: "endpoint-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
    });
    await client.connect(transport);
    return client;
  }

  it.each([
    ["no key", null],
    ["a malformed key", "not-a-key"],
    ["a well-formed unknown key", generateApiKey().key],
  ])("rejects %s with 401", async (_label, key) => {
    await expectStatus(connect(key), 401);
  });

  it("lists only reachable tools, quickly, despite a dead and a hanging upstream", async () => {
    const client = await connect(userKey);
    const startedAt = Date.now();
    const { tools } = await client.listTools();
    expect(Date.now() - startedAt).toBeLessThan(500);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("woocommerce__list_orders");
    expect(names.some((n) => n.startsWith("dead__"))).toBe(false);
    await client.close();
  });

  it("calls the healthy upstream while another one hangs, and audits both", async () => {
    const client = await connect(userKey);
    const startedAt = Date.now();
    const [slow, fast] = (await Promise.all([
      client.callTool({ name: "hanging__slow_tool", arguments: {} }),
      client.callTool({ name: "woocommerce__list_orders", arguments: { value: "today" } }),
    ])) as CallToolResult[];
    expect(fast.content).toEqual([{ type: "text", text: "list_orders:today" }]);
    expect(slow.isError).toBe(true);
    expect(JSON.stringify(slow.content)).toMatch(/timed out after 500ms/);
    expect(Date.now() - startedAt).toBeLessThan(1_500);

    const audit = await queryAudit(t.db, { userId });
    expect(audit.map((e) => [e.tool_name, e.outcome, e.api_key_id])).toEqual(
      expect.arrayContaining([
        ["woocommerce__list_orders", "success", userKeyId],
        ["hanging__slow_tool", "timeout", userKeyId],
      ]),
    );
    await client.close();
  });

  it("never forwards the caller's key upstream - only the stored credential", async () => {
    const seen = healthy.requests.map((h) => h.authorization);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a === "Bearer upstream-token")).toBe(true);
  });

  it("rejects a revoked key on the very next request of an open client", async () => {
    const k = generateApiKey();
    const key = await insertApiKey(t.db, { userId, name: "temp", ...k });
    const client = await connect(k.key);
    await client.listTools();
    await revokeApiKey(t.db, key.id);
    await expectStatus(client.listTools(), 401);
  });

  it("answers GET and DELETE with 405 (stateless, no sessions)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${userKey}` },
      });
      expect(res.status).toBe(405);
    }
  });

  it("serves health and readiness without auth", async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${baseUrl}/readyz`)).json()).toEqual({ status: "ready" });
  });
});
