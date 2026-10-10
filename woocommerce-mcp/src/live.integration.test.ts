import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WcClient } from "./wc/client.js";

/**
 * Live test against the deployed stack in k3d: the real MCP server pod, the
 * real WordPress + WooCommerce, the real OAuth signature check. Skipped
 * unless the env below is set; scripts/verify-phase2.sh sets it up with
 * kubectl port-forward and the values from the cluster's Secrets.
 */
const env = {
  mcpUrl: process.env.MCP_LIVE_URL,
  mcpToken: process.env.MCP_LIVE_TOKEN,
  wcUrl: process.env.WC_LIVE_URL,
  wcSigningUrl: process.env.WC_LIVE_SIGNING_URL,
  wcKey: process.env.WC_LIVE_KEY,
  wcSecret: process.env.WC_LIVE_SECRET,
};
const enabled = Object.values(env).every(Boolean);

describe.skipIf(!enabled)("live: deployed MCP server against the real store", () => {
  // Used only for test setup/cleanup (MCP has no create-order or delete tools).
  let wc: WcClient;
  let client: Client;
  const sku = `LIVE-${Date.now()}`;
  let productId: number | undefined;
  let orderId: number | undefined;

  beforeAll(async () => {
    wc = new WcClient({
      baseUrl: env.wcUrl!,
      signingUrl: env.wcSigningUrl!,
      consumerKey: env.wcKey!,
      consumerSecret: env.wcSecret!,
      timeoutMs: 15000,
    });
    client = new Client({ name: "live-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(env.mcpUrl!), {
        requestInit: { headers: { Authorization: `Bearer ${env.mcpToken}` } },
      }),
    );
  });

  afterAll(async () => {
    if (orderId) await wc.delete(`/orders/${orderId}`, { force: true }).catch(() => undefined);
    if (productId)
      await wc.delete(`/products/${productId}`, { force: true }).catch(() => undefined);
    await client?.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(result.isError, `${name} failed: ${text}`).toBeFalsy();
    return JSON.parse(text);
  }

  it("lists the seeded demo products", async () => {
    for (const sku of ["DEMO-MUG", "DEMO-TEE", "DEMO-STICKERS"]) {
      const data = await call("list_products", { sku });
      expect(data.products.map((p: { sku: string }) => p.sku)).toEqual([sku]);
    }
    const searched = await call("list_products", { search: "Coffee Mug" });
    expect(searched.products.map((p: { sku: string }) => p.sku)).toContain("DEMO-MUG");
  });

  it("creates a product that is then listed", async () => {
    const data = await call("create_product", {
      name: `Live Test Hat ${sku}`,
      regular_price: "17.25",
      sku,
    });
    productId = data.created.id;
    expect(data.created).toMatchObject({ sku, regular_price: "17.25", status: "publish" });

    const listed = await call("list_products", { sku });
    expect(listed.products.map((p: { id: number }) => p.id)).toContain(productId);
  });

  it("finds today's order, reads it and updates its status", async () => {
    const created = await wc.post<{ id: number }>("/orders", {
      payment_method: "cod",
      payment_method_title: "Cash on delivery",
      status: "processing",
      billing: { first_name: "Live", last_name: "Test", email: "live@example.com" },
      line_items: [{ product_id: productId, quantity: 2 }],
    });
    orderId = created.id;

    const today = new Date().toISOString().slice(0, 10);
    const listed = await call("list_orders", { after: `${today}T00:00:00` });
    expect(listed.orders.map((o: { id: number }) => o.id)).toContain(orderId);

    const order = await call("get_order", { id: orderId });
    expect(order).toMatchObject({
      id: orderId,
      total: "34.50",
      customer: { name: "Live Test" },
      items: [expect.objectContaining({ product_id: productId, quantity: 2 })],
    });

    const updated = await call("update_order_status", { id: orderId, status: "completed" });
    expect(updated.updated.status).toBe("completed");
  });

  it("returns a clear error for an order that doesn't exist", async () => {
    const result = (await client.callTool({
      name: "get_order",
      arguments: { id: 99999999 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "Order 99999999 not found" });
  });
});
