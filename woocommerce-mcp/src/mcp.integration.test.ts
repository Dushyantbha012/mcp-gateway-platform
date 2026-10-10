import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandler } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./http.js";
import { failures, fakeFetch, WC_BASE, wcHandlers } from "./test/fake-woocommerce.js";
import { WcClient } from "./wc/client.js";

/**
 * Real MCP protocol over real HTTP: the SDK's Streamable HTTP client talks to
 * our Express app on a random port. Only WooCommerce itself is faked, by
 * giving the WcClient a fetch backed by msw handlers.
 */
const TOKEN = "test-token-0123456789abcdef";
const baseHandlers = wcHandlers();
let overrides: RequestHandler[] = [];
let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const wc = new WcClient({
    baseUrl: WC_BASE,
    signingUrl: WC_BASE,
    consumerKey: "ck_test",
    consumerSecret: "cs_test",
    timeoutMs: 300,
    fetch: fakeFetch(() => [...overrides, ...baseHandlers]),
  });
  httpServer = createApp({ wc, authToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(() => {
  overrides = [];
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

async function connect(token: string | null = TOKEN) {
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

describe("Streamable HTTP endpoint", () => {
  it("lists the five tools and calls each of them", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);

    const calls: [string, Record<string, unknown>][] = [
      ["list_products", {}],
      ["create_product", { name: "Integration Hat", regular_price: "9.50" }],
      ["list_orders", { after: "2026-10-10T00:00:00" }],
      ["get_order", { id: 100 }],
      ["update_order_status", { id: 100, status: "completed" }],
    ];
    for (const [name, args] of calls) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.isError, `${name} should succeed`).toBeFalsy();
    }
    await client.close();
  });

  it("rejects a missing token with 401", async () => {
    await expect(connect(null)).rejects.toThrow(/401|Unauthorized/);
  });

  it("rejects a wrong token with 401", async () => {
    await expect(connect("wrong-token-0123456789abcdef")).rejects.toThrow(/401|Unauthorized/);
  });

  it("returns 405 for GET and DELETE (stateless: no SSE stream, no sessions)", async () => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${baseUrl}/mcp`, { headers })).status).toBe(405);
    expect((await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers })).status).toBe(405);
  });

  it("keeps serving after WooCommerce times out", async () => {
    const client = await connect();
    overrides = [failures.hang];
    const slow = (await client.callTool({ name: "list_orders", arguments: {} })) as CallToolResult;
    expect(slow.isError).toBe(true);
    overrides = [];
    const fine = (await client.callTool({
      name: "get_order",
      arguments: { id: 100 },
    })) as CallToolResult;
    expect(fine.isError).toBeFalsy();
    await client.close();
  });

  it("serves health endpoints without auth", async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
  });
});
