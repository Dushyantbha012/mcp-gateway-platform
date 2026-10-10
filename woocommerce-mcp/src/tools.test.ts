import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";
import { failures, requests, WC_BASE, wcHandlers } from "./test/fake-woocommerce.js";
import { WcClient } from "./wc/client.js";

const msw = setupServer();
beforeAll(() => msw.listen({ onUnhandledRequest: "error" }));
afterAll(() => msw.close());

let client: Client;

beforeEach(async () => {
  msw.use(...wcHandlers()); // fresh in-memory store per test
  const wc = new WcClient({
    baseUrl: WC_BASE,
    signingUrl: WC_BASE,
    consumerKey: "ck_test",
    consumerSecret: "cs_test",
    timeoutMs: 300,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(wc).connect(serverSide);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  msw.resetHandlers();
  requests.length = 0;
});

async function call(name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function json(result: CallToolResult) {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text);
}

function errorText(result: CallToolResult) {
  expect(result.isError).toBe(true);
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("tools/list", () => {
  it("exposes exactly the five WooCommerce tools with schemas and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_product",
      "get_order",
      "list_orders",
      "list_products",
      "update_order_status",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.create_product!.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "regular_price"]),
    );
    expect(byName.update_order_status!.inputSchema.required).toEqual(
      expect.arrayContaining(["id", "status"]),
    );
    expect(byName.list_orders!.annotations?.readOnlyHint).toBe(true);
    expect(byName.update_order_status!.annotations?.destructiveHint).toBe(true);
  });
});

describe("list_products", () => {
  it("returns compact products and forwards filters", async () => {
    const data = json(await call("list_products", { search: "mug", per_page: 5 }));
    expect(data.products).toEqual([
      expect.objectContaining({
        id: 10,
        name: "Urumi Coffee Mug",
        price: "12.00",
        sku: "DEMO-MUG",
      }),
    ]);
    expect(data.products[0]).not.toHaveProperty("_links");
    expect(requests[0]!.url.searchParams.get("search")).toBe("mug");
    expect(requests[0]!.url.searchParams.get("per_page")).toBe("5");
  });

  it("rejects per_page over 100 before calling WooCommerce", async () => {
    const result = await call("list_products", { per_page: 500 });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("create_product", () => {
  it("creates a published simple product", async () => {
    const data = json(await call("create_product", { name: "Demo Hat", regular_price: "19.99" }));
    expect(data.created).toMatchObject({ id: 11, name: "Demo Hat", regular_price: "19.99" });
    expect(requests[0]!.body).toMatchObject({
      name: "Demo Hat",
      regular_price: "19.99",
      type: "simple",
      status: "publish",
    });
  });

  it("enables stock management only when a quantity is given", async () => {
    await call("create_product", { name: "Hat", regular_price: "5", stock_quantity: 3 });
    expect(requests[0]!.body).toMatchObject({ manage_stock: true, stock_quantity: 3 });
  });

  it.each(["-1", "abc", "1.999", ""])("rejects invalid price %j", async (regular_price) => {
    const result = await call("create_product", { name: "Hat", regular_price });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("surfaces WooCommerce validation errors", async () => {
    msw.use(failures.badRequest);
    const text = errorText(await call("create_product", { name: "Hat", regular_price: "5" }));
    expect(text).toContain("Invalid parameter(s): regular_price");
  });
});

describe("list_orders", () => {
  it("returns compact orders and passes date filters through", async () => {
    const data = json(await call("list_orders", { after: "2026-10-10T00:00:00", status: "any" }));
    expect(data.orders[0]).toEqual({
      id: 100,
      number: "100",
      status: "processing",
      total: "12.00",
      currency: "USD",
      payment_method: "Cash on delivery",
      created_at: "2026-10-10T10:30:00",
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
      items: [{ product_id: 10, name: "Urumi Coffee Mug", quantity: 1, total: "12.00" }],
      note: null,
    });
    expect(requests[0]!.url.searchParams.get("after")).toBe("2026-10-10T00:00:00");
  });

  it("rejects a non-ISO date", async () => {
    const result = await call("list_orders", { after: "today" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("get_order", () => {
  it("returns one order", async () => {
    expect(json(await call("get_order", { id: 100 }))).toMatchObject({ id: 100, total: "12.00" });
  });

  it("says clearly when the order doesn't exist", async () => {
    expect(errorText(await call("get_order", { id: 999 }))).toBe("Order 999 not found");
  });

  it("rejects a non-positive id", async () => {
    expect((await call("get_order", { id: 0 })).isError).toBe(true);
  });
});

describe("update_order_status", () => {
  it("updates the status", async () => {
    const data = json(await call("update_order_status", { id: 100, status: "completed" }));
    expect(data.updated.status).toBe("completed");
    expect(requests[0]).toMatchObject({ method: "PUT", body: { status: "completed" } });
  });

  it("rejects an unknown status", async () => {
    expect((await call("update_order_status", { id: 100, status: "shipped" })).isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("says clearly when the order doesn't exist", async () => {
    expect(errorText(await call("update_order_status", { id: 5, status: "completed" }))).toBe(
      "Order 5 not found",
    );
  });
});

describe("WooCommerce failures become readable tool errors", () => {
  it.each([
    ["unauthorized", failures.unauthorized, /rejected the API credentials/],
    ["server error", failures.serverError, /WooCommerce error: HTTP 500/],
    ["timeout", failures.hang, /did not respond within 300ms/],
  ])("%s", async (_label, handler, message) => {
    msw.use(handler);
    expect(errorText(await call("list_orders"))).toMatch(message);
  });
});
