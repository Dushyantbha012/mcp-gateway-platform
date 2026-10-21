/**
 * A stdio MCP server for the bridge's tests, run as a child process.
 * `env` shows what the child was given; `crash` makes it exit.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.2.3" });
server.registerTool(
  "echo",
  {
    description: "Echoes its input",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool("env", { inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: "text", text: process.env[name] ?? "<unset>" }],
}));
server.registerTool("slow", { inputSchema: { ms: z.number() } }, async ({ ms }) => {
  await new Promise((r) => setTimeout(r, ms));
  return { content: [{ type: "text", text: "done" }] };
});
server.registerTool("fail", {}, async () => ({
  isError: true,
  content: [{ type: "text", text: "it went wrong" }],
}));
server.registerTool("crash", {}, async () => process.exit(3));

await server.connect(new StdioServerTransport());
