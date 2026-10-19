import { createApp } from "../app.js";
import type { ChatSetup } from "../api/chat.js";
import type { AuthConfig } from "../config.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import { hashPassword } from "../crypto/passwords.js";
import { MemoryCredentialStore } from "../credentials/store.js";
import { insertApiKey } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import type { Role } from "../db/schema.js";
import { listServers } from "../db/servers.js";
import { GatewayMetrics } from "../metrics/metrics.js";
import { createUser, setPasswordHash } from "../db/users.js";
import { HealthChecker } from "../upstreams/health.js";
import { UpstreamRegistry } from "../upstreams/registry.js";
import { ToolRouter } from "../upstreams/router.js";
import { PERMISSIVE_POLICY, type SsrfPolicy } from "../security/ssrf.js";

export const TEST_ORIGIN = "http://dashboard.test";

export const testAuthConfig: AuthConfig = {
  dashboardUrl: TEST_ORIGIN,
  publicMcpUrl: "http://gateway.test/mcp",
  allowedOrigins: [TEST_ORIGIN],
  cookieSecure: false,
  sessionTtlMs: 3_600_000,
  inviteTtlMs: 3_600_000,
};

/** The gateway app wired exactly as index.ts does, with short test timeouts. */
export function buildTestApp(
  db: Db,
  auth: Partial<AuthConfig> = {},
  opts: {
    trustProxyHops?: number;
    chat?: ChatSetup;
    ssrf?: SsrfPolicy;
    /** Serve /metrics, as index.ts does unless METRICS_ENABLED=false. */
    metrics?: boolean;
  } = {},
) {
  const credentials = new MemoryCredentialStore();
  const ssrf = opts.ssrf ?? PERMISSIVE_POLICY;
  const registry = new UpstreamRegistry(credentials, { maxResultBytes: 100_000, ssrf });
  const health = new HealthChecker(db, registry, { intervalMs: 60_000, listTimeoutMs: 300 });
  const metrics = opts.metrics ? new GatewayMetrics(() => listServers(db)) : undefined;
  const router = new ToolRouter(db, registry, metrics);
  const config = { auth: { ...testAuthConfig, ...auth }, trustProxyHops: opts.trustProxyHops ?? 0 };
  const deps = {
    db,
    credentials,
    registry,
    health,
    router,
    ssrf,
    config,
    chat: opts.chat,
    metrics,
  };
  return { ...deps, app: createApp(deps) };
}

/** A user with one API key; returns the plaintext key for requests. */
export async function userWithKey(db: Db, email: string, role: Role) {
  const user = await createUser(db, { email, name: email.split("@")[0], role });
  const generated = generateApiKey();
  const info = await insertApiKey(db, { userId: user.id, name: "test", ...generated });
  return { user, key: generated.key, keyId: info.id };
}

/** A user who can log in to the dashboard with `password`. */
export async function userWithPassword(db: Db, email: string, role: Role, password: string) {
  const user = await createUser(db, { email, name: email.split("@")[0], role });
  await setPasswordHash(db, user.id, await hashPassword(password));
  return { user, email, password };
}
