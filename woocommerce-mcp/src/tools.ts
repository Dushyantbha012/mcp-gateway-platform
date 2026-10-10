import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WcError, type WcClient } from "./wc/client.js";
import { toOrder, toProduct, type WcOrder, type WcProduct } from "./wc/dto.js";

export const ORDER_STATUSES = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
] as const;

const price = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "price must be a non-negative decimal like 19.99");
const isoDate = z.iso.datetime({ offset: true, local: true });
const id = z.number().int().positive();
const page = z.number().int().min(1).default(1).describe("Page number, starting at 1");
const perPage = z.number().int().min(1).max(100).default(20).describe("Results per page (max 100)");

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Errors become tool results with isError: true (not protocol errors), so the
 * caller - usually an LLM - sees a readable reason and can react to it.
 */
function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(
  action: () => Promise<CallToolResult>,
  notFound: string,
): Promise<CallToolResult> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof WcError) {
      return fail(err.kind === "not_found" ? notFound : err.message);
    }
    throw err;
  }
}

export function registerTools(server: McpServer, wc: WcClient): void {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List products in the WooCommerce store, newest first. Optionally filter by a search term or status.",
      inputSchema: {
        search: z.string().min(1).optional().describe("Match against product name and SKU"),
        status: z.enum(["publish", "draft", "pending", "private", "any"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ search, status, page, per_page }) =>
      run(async () => {
        const products = await wc.get<WcProduct[]>("/products", {
          search,
          status,
          page,
          per_page,
        });
        return ok({ count: products.length, page, products: products.map(toProduct) });
      }, "No products found"),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product in the WooCommerce store. Published products appear on the storefront immediately.",
      inputSchema: {
        name: z.string().min(1).max(200),
        regular_price: price.describe('Price as a decimal string, e.g. "19.99"'),
        description: z.string().max(5000).optional(),
        sku: z.string().min(1).max(100).optional(),
        stock_quantity: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("If set, stock is tracked for this product"),
        status: z.enum(["publish", "draft"]).default("publish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ name, regular_price, description, sku, stock_quantity, status }) =>
      run(async () => {
        const product = await wc.post<WcProduct>("/products", {
          name,
          type: "simple",
          regular_price,
          description,
          sku,
          status,
          ...(stock_quantity === undefined ? {} : { manage_stock: true, stock_quantity }),
        });
        return ok({ created: toProduct(product) });
      }, "Products endpoint not found"),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. To get today's orders, pass `after` as today's date at 00:00:00 " +
        "(e.g. 2026-10-10T00:00:00). Dates without an offset are in the store's timezone.",
      inputSchema: {
        status: z.enum([...ORDER_STATUSES, "any"]).optional(),
        after: isoDate.optional().describe("Only orders created after this ISO 8601 date-time"),
        before: isoDate.optional().describe("Only orders created before this ISO 8601 date-time"),
        page,
        per_page: perPage,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ status, after, before, page, per_page }) =>
      run(async () => {
        const orders = await wc.get<WcOrder[]>("/orders", {
          status,
          after,
          before,
          page,
          per_page,
        });
        return ok({ count: orders.length, page, orders: orders.map(toOrder) });
      }, "No orders found"),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its ID, including line items and customer details.",
      inputSchema: { id: id.describe("Order ID") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) =>
      run(async () => ok(toOrder(await wc.get<WcOrder>(`/orders/${id}`))), `Order ${id} not found`),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change an order's status, e.g. mark it completed or cancelled.",
      inputSchema: {
        id: id.describe("Order ID"),
        status: z.enum(ORDER_STATUSES),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ id, status }) =>
      run(async () => {
        const order = await wc.put<WcOrder>(`/orders/${id}`, { status });
        return ok({ updated: toOrder(order) });
      }, `Order ${id} not found`),
  );
}
