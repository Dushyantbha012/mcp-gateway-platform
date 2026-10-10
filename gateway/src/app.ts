import { sql } from "kysely";
import express, { type NextFunction, type Request, type Response } from "express";
import { requireApiKey } from "./auth/middleware.js";
import type { Db } from "./db/db.js";
import { log } from "./logger.js";
import { mcpRouter } from "./mcp/endpoint.js";
import type { ToolRouter } from "./upstreams/router.js";

export interface AppDeps {
  db: Db;
  router: ToolRouter;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");

  // Liveness: the process is up. Readiness: it can reach Postgres, without
  // which it can't authenticate anyone. Neither depends on upstreams - a dead
  // upstream must never take the gateway out of rotation.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await sql`select 1`.execute(deps.db);
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });

  app.use("/mcp", requireApiKey(deps.db, "jsonrpc"), mcpRouter(deps.router));

  // Express 5 forwards rejected async handlers here. Never echo internals.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: "bad_request", message: "Malformed request" } });
      return;
    }
    log("error", "unhandled request error", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
  });

  return app;
}
