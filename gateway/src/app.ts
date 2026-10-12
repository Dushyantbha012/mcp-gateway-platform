import { sql } from "kysely";
import express from "express";
import { auditApi } from "./api/audit.js";
import { chatApi, type ChatSetup } from "./api/chat.js";
import { authApi } from "./api/auth.js";
import { errorHandler, HttpError } from "./api/errors.js";
import { permissionsApi } from "./api/permissions.js";
import { serversApi } from "./api/servers.js";
import { usersApi } from "./api/users.js";
import { principalOf, requireAuth } from "./auth/middleware.js";
import type { Config } from "./config.js";
import type { CredentialStore } from "./credentials/store.js";
import type { Db } from "./db/db.js";
import { mcpRouter } from "./mcp/endpoint.js";
import type { SsrfPolicy } from "./security/ssrf.js";
import type { HealthChecker } from "./upstreams/health.js";
import type { UpstreamRegistry } from "./upstreams/registry.js";
import type { ToolRouter } from "./upstreams/router.js";

export interface AppDeps {
  db: Db;
  credentials: CredentialStore;
  registry: UpstreamRegistry;
  health: HealthChecker;
  router: ToolRouter;
  /** Which upstream URLs may be registered (SSRF guard). */
  ssrf: SsrfPolicy;
  config: Pick<Config, "auth" | "trustProxyHops">;
  /** The chat agent's model and limits; absent = chat switched off (503). */
  chat?: ChatSetup;
}

export function createApp(deps: AppDeps) {
  const { auth } = deps.config;
  const app = express();
  app.disable("x-powered-by");
  // req.ip from X-Forwarded-For set by this many proxies (Traefik), for the
  // login rate limit.
  app.set("trust proxy", deps.config.trustProxyHops);

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

  // MCP clients authenticate with API keys only. The session cookie is
  // scoped to /api, and isn't accepted here even if sent.
  app.use(
    "/mcp",
    requireAuth(deps.db, { style: "jsonrpc", allowSession: false }),
    mcpRouter(deps.router),
  );

  const api = express.Router();
  // Login, logout and invites: how a browser gets a session in the first place.
  api.use("/auth", authApi(deps.db, auth));
  api.use(
    requireAuth(deps.db, {
      style: "rest",
      allowSession: true,
      allowedOrigins: auth.allowedOrigins,
    }),
    express.json({ limit: "100kb" }),
  );
  /** Exactly what this caller's MCP client gets from tools/list right now. */
  api.get("/tools", async (_req, res) => {
    res.json(await deps.router.listTools(principalOf(res)));
  });
  /** Public settings the dashboard shows, so one dashboard image fits every environment. */
  api.get("/meta", (_req, res) => {
    res.json({ mcpUrl: auth.publicMcpUrl ?? null, chatEnabled: deps.chat !== undefined });
  });
  api.use("/servers", serversApi(deps));
  api.use("/permissions", permissionsApi(deps.db));
  api.use("/audit", auditApi(deps.db));
  api.use("/chat", chatApi(deps.router, deps.chat));
  api.use(usersApi(deps.db, auth));
  api.use(() => {
    throw new HttpError(404, "not_found", "No such endpoint");
  });
  app.use("/api", api);

  app.use(errorHandler);
  return app;
}
