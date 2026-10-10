import { sql } from "kysely";
import express from "express";
import { auditApi } from "./api/audit.js";
import { errorHandler, HttpError } from "./api/errors.js";
import { serversApi } from "./api/servers.js";
import { usersApi } from "./api/users.js";
import { requireApiKey } from "./auth/middleware.js";
import type { SecretBox } from "./crypto/secretBox.js";
import type { Db } from "./db/db.js";
import { mcpRouter } from "./mcp/endpoint.js";
import type { HealthChecker } from "./upstreams/health.js";
import type { UpstreamRegistry } from "./upstreams/registry.js";
import type { ToolRouter } from "./upstreams/router.js";

export interface AppDeps {
  db: Db;
  box: SecretBox;
  registry: UpstreamRegistry;
  health: HealthChecker;
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

  const api = express.Router();
  api.use(requireApiKey(deps.db, "rest"), express.json({ limit: "100kb" }));
  api.use("/servers", serversApi(deps));
  api.use("/audit", auditApi(deps.db));
  api.use(usersApi(deps.db));
  api.use(() => {
    throw new HttpError(404, "not_found", "No such endpoint");
  });
  app.use("/api", api);

  app.use(errorHandler);
  return app;
}
