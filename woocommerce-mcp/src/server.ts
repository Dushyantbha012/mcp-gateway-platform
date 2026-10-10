import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import type { WcClient } from "./wc/client.js";

export const SERVER_NAME = "woocommerce-mcp";
export const SERVER_VERSION = "0.2.0";

/** A fresh MCP server with all five WooCommerce tools registered. */
export function createMcpServer(wc: WcClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for one WooCommerce store: list/create products, list/get orders, update order status. " +
        "Prices are decimal strings in the store currency.",
    },
  );
  registerTools(server, wc);
  return server;
}
