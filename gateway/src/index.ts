import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { K8sSecretStore } from "./credentials/k8s.js";
import { sweepOrphanedCredentials } from "./credentials/sweep.js";
import { MemoryCredentialStore } from "./credentials/store.js";
import { createDb, migrate, waitForDatabase } from "./db/db.js";
import { log } from "./logger.js";
import { GeminiClient } from "./chat/gemini.js";
import { seed } from "./seed.js";
import { policyFrom } from "./security/ssrf.js";
import { HealthChecker } from "./upstreams/health.js";
import { UpstreamRegistry } from "./upstreams/registry.js";
import { ToolRouter } from "./upstreams/router.js";

// Node tries each resolved address (IPv6 and IPv4, "happy eyeballs") for only
// 250ms by default before moving on. A remote upstream with a ~400ms TCP
// handshake then fails with ETIMEDOUT even though it's reachable - seen with
// DeepWiki from k3d. A per-attempt budget of 1s still falls back quickly when
// an address family has no route at all.
setDefaultAutoSelectFamilyAttemptTimeout(1_000);

const config = loadConfig();
const db = createDb(config.databaseUrl);

await waitForDatabase(db, {
  attempts: 50, // 100s: inside the startup probe's 120s budget
  delayMs: 2_000,
  onRetry: (error) => log("warn", "waiting for database", { error }),
});
const applied = await migrate(db);
if (applied.length) log("info", "applied migrations", { migrations: applied });
const credentials = config.upstreamSecretsNamespace
  ? await K8sSecretStore.inCluster(config.upstreamSecretsNamespace)
  : new MemoryCredentialStore();
if (!config.upstreamSecretsNamespace) {
  log("warn", "UPSTREAM_SECRETS_NAMESPACE not set: upstream credentials are kept in memory only");
}
await seed(db, credentials, config);
await sweepOrphanedCredentials(db, credentials).catch((error) =>
  log("warn", "orphaned credential sweep failed", { error: String(error) }),
);

// Private hostnames that are allowed on purpose: the allowlist from Helm, plus
// the seeded in-cluster WooCommerce MCP server.
const ssrf = policyFrom([
  ...config.ssrfAllowedHosts,
  ...(config.seedWoocommerce ? [new URL(config.seedWoocommerce.url).hostname] : []),
]);
const registry = new UpstreamRegistry(credentials, { maxResultBytes: config.maxResultBytes, ssrf });
const health = new HealthChecker(db, registry, {
  intervalMs: config.healthIntervalMs,
  listTimeoutMs: config.listTimeoutMs,
});
const router = new ToolRouter(db, registry);
health.start();

const chat = config.chat && {
  llm: new GeminiClient({
    apiKey: config.chat.apiKey,
    model: config.chat.model,
    baseUrl: config.chat.baseUrl,
  }),
  limits: { maxSteps: config.chat.maxSteps, turnTimeoutMs: config.chat.turnTimeoutMs },
  turnsPerMinute: config.chat.turnsPerMinute,
};
log("info", chat ? "chat agent enabled" : "chat agent disabled (no GEMINI_API_KEY)", {
  model: config.chat?.model,
});

const app = createApp({ db, credentials, registry, health, router, ssrf, config, chat });
const server = app.listen(config.port, "0.0.0.0", () => {
  log("info", "gateway listening", { port: config.port });
});

// Kubernetes sends SIGTERM on pod shutdown: stop accepting connections, let
// in-flight requests finish, then close upstream sessions and the DB pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "shutting down", { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async () => {
      await health.stop();
      await registry.closeAll();
      await db.destroy();
      process.exit(0);
    });
  });
}
