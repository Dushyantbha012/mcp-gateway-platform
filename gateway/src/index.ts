import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSecretBox } from "./crypto/secretBox.js";
import { createDb, migrate, waitForDatabase } from "./db/db.js";
import { log } from "./logger.js";
import { seed } from "./seed.js";
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
const box = createSecretBox(config.encryptionKey);

await waitForDatabase(db, {
  attempts: 50, // 100s: inside the startup probe's 120s budget
  delayMs: 2_000,
  onRetry: (error) => log("warn", "waiting for database", { error }),
});
const applied = await migrate(db);
if (applied.length) log("info", "applied migrations", { migrations: applied });
await seed(db, box, config);

const registry = new UpstreamRegistry(box, { maxResultBytes: config.maxResultBytes });
const health = new HealthChecker(db, registry, {
  intervalMs: config.healthIntervalMs,
  listTimeoutMs: config.listTimeoutMs,
});
const router = new ToolRouter(db, registry);
health.start();

const app = createApp({ db, box, registry, health, router, config });
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
