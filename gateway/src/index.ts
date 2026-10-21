import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { K8sHostedEnvStore, MemoryHostedEnvStore } from "./credentials/hostedEnv.js";
import { K8sSecretStore } from "./credentials/k8s.js";
import { sweepOrphanedCredentials } from "./credentials/sweep.js";
import { MemoryCredentialStore } from "./credentials/store.js";
import { createDb, migrate, waitForDatabase } from "./db/db.js";
import { K8sClient } from "./k8s/client.js";
import { listServers } from "./db/servers.js";
import { log } from "./logger.js";
import { GatewayMetrics } from "./metrics/metrics.js";
import { DEFAULT_LIMITS } from "./chat/agent.js";
import { GeminiClient } from "./chat/gemini.js";
import { GroqClient } from "./chat/groq.js";
import { seed } from "./seed.js";
import { ToolSurface } from "./search/surface.js";
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
// One Kubernetes client for both kinds of Secret in the upstream-secrets namespace.
const k8s = config.upstreamSecretsNamespace ? await K8sClient.inCluster() : undefined;
const credentials =
  k8s && config.upstreamSecretsNamespace
    ? new K8sSecretStore({ apiUrl: "", namespace: config.upstreamSecretsNamespace, client: k8s })
    : new MemoryCredentialStore();
const hostedEnv =
  k8s && config.upstreamSecretsNamespace
    ? new K8sHostedEnvStore(k8s, config.upstreamSecretsNamespace)
    : new MemoryHostedEnvStore();
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
const metrics = config.metricsEnabled ? new GatewayMetrics(() => listServers(db)) : undefined;
const router = new ToolRouter(db, registry, metrics, config.memberDefault, config.mcpConfirmWrites);
const tools = new ToolSurface(
  router,
  { mode: config.searchMode, autoThreshold: config.searchAutoThreshold },
  metrics,
);
health.start();

const chatProviders = (config.chat?.providers ?? []).map((p) => ({
  id: p.id,
  model: p.model,
  limits: p.limits,
  llm:
    p.id === "groq"
      ? new GroqClient({
          apiKey: p.apiKey,
          model: p.model,
          baseUrl: p.baseUrl,
          reasoningEffort: p.reasoningEffort,
        })
      : new GeminiClient({ apiKey: p.apiKey, model: p.model, baseUrl: p.baseUrl }),
}));
const defaultChatProvider = chatProviders.find((p) => p.id === config.chat?.provider);

const chat = config.chat &&
  defaultChatProvider && {
    llm: defaultChatProvider.llm,
    providers: chatProviders,
    defaultProvider: defaultChatProvider.id,
    // Searching costs the model an extra step and call before each real tool.
    limits: {
      maxSteps: config.chat.maxSteps + (config.chat.searchMode === "off" ? 0 : 4),
      ...(config.chat.searchMode === "off"
        ? {}
        : { maxToolCalls: DEFAULT_LIMITS.maxToolCalls + 8 }),
      turnTimeoutMs: config.chat.turnTimeoutMs,
    },
    turnsPerMinute: config.chat.turnsPerMinute,
    searchMode: config.chat.searchMode,
    confirmWrites: config.chat.confirmWrites,
    searchAutoThreshold: config.searchAutoThreshold,
  };
log("info", "tool surface", {
  searchMode: config.searchMode,
  chatSearchMode: config.chat?.searchMode,
});
log(
  "info",
  chat ? "chat agent enabled" : "chat agent disabled (set GROQ_API_KEY or GEMINI_API_KEY)",
  {
    provider: chat?.defaultProvider,
    model: defaultChatProvider?.model,
    switchableTo: chatProviders.map((p) => p.id),
  },
);

const app = createApp({
  db,
  credentials,
  hostedEnv,
  registry,
  health,
  router,
  ssrf,
  config,
  chat,
  metrics,
  tools,
});
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
