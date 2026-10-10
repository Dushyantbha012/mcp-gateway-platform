import { timingSafeEqual, createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./logger.js";
import { createMcpServer } from "./server.js";
import type { WcClient } from "./wc/client.js";

/** Constant-time compare; hashing first makes both sides the same length. */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function requireBearer(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!given || !tokenMatches(given, token)) {
      res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
      return;
    }
    next();
  };
}

export function createApp(opts: { wc: WcClient; authToken: string }) {
  const app = express();
  app.disable("x-powered-by");

  // Liveness/readiness don't depend on WooCommerce: a store outage should
  // surface as clear tool errors, not as this pod restarting.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    res.json({ status: "ready" });
  });

  // Stateless Streamable HTTP: every POST gets a fresh server + transport, no
  // session id. Nothing to share between replicas, no sticky sessions.
  // enableJsonResponse: our tools are plain request/response (no progress
  // notifications), so a single JSON body is simpler than an SSE stream for
  // every caller, including the gateway.
  app.post(
    "/mcp",
    requireBearer(opts.authToken),
    express.json({ limit: "1mb" }),
    async (req, res) => {
      const started = Date.now();
      const server = createMcpServer(opts.wc);
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
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    },
  );

  // No server-initiated streams or sessions in stateless mode.
  const notAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}
