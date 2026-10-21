import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import type { Upstream } from "./upstream.js";

/** Constant-time compare; hashing first makes both sides the same length. */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const rpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

function requireBearer(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!given || !tokenMatches(given, token)) {
      res.set("WWW-Authenticate", "Bearer");
      rpcError(res, 401, -32001, "Unauthorized");
      return;
    }
    next();
  };
}

/**
 * A per-request MCP server whose tool handlers forward to the shared stdio
 * client. Only tools are bridged: they are all the gateway uses.
 */
function forwardingServer(upstream: Upstream, timeoutMs: number) {
  const info = upstream.client.getServerVersion();
  const server = new Server(
    { name: info?.name ?? "mcp-bridge", version: info?.version ?? "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions: upstream.client.getInstructions(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, (req) =>
    upstream.client.listTools(req.params, { timeout: timeoutMs }),
  );
  server.setRequestHandler(
    CallToolRequestSchema,
    async (req) =>
      (await upstream.client.callTool(req.params, undefined, {
        timeout: timeoutMs,
      })) as CallToolResult,
  );
  return server;
}

export function createApp(opts: { upstream: Upstream; authToken: string; timeoutMs: number }) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  // Ready once the stdio server has answered `initialize`.
  app.get("/readyz", (_req, res) => {
    if (opts.upstream.ready) res.json({ status: "ready" });
    else res.status(503).json({ status: "starting" });
  });

  // Stateless Streamable HTTP, like woocommerce-mcp: a fresh server and
  // transport per POST, JSON responses, no sessions.
  app.post(
    "/mcp",
    requireBearer(opts.authToken),
    express.json({ limit: "1mb" }),
    async (req, res) => {
      if (!opts.upstream.ready) {
        rpcError(res, 503, -32000, "The MCP server is still starting");
        return;
      }
      const started = Date.now();
      const server = forwardingServer(opts.upstream, opts.timeoutMs);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        const body = req.body as { method?: string; params?: { name?: string } } | undefined;
        log("info", "mcp request", {
          method: body?.method,
          tool: body?.method === "tools/call" ? body.params?.name : undefined,
          durationMs: Date.now() - started,
          status: res.statusCode,
        });
      } catch (err) {
        log("error", "mcp request failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
      }
    },
  );

  const notAllowed = (_req: Request, res: Response) => {
    res.set("Allow", "POST");
    rpcError(res, 405, -32000, "Method not allowed");
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}
