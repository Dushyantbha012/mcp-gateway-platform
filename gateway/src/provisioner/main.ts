import { createServer } from "node:http";
import pg from "pg";
import { Counter, Gauge, Registry } from "prom-client";
import { z } from "zod";
import { K8sSecretStore } from "../credentials/k8s.js";
import { createDb, migrate, waitForDatabase } from "../db/db.js";
import { pendingHosted } from "../db/hosted.js";
import { storeCounts } from "../db/stores.js";
import { K8sClient } from "../k8s/client.js";
import { log } from "../logger.js";
import { loadBootstrapFiles } from "./bootstrapFiles.js";
import { HostedReconciler } from "./hostedReconciler.js";
import { ProvisionerLoop } from "./loop.js";
import { StoreReconciler } from "./reconciler.js";
import { parseStoreTemplate } from "./template.js";

/**
 * The provisioner: its own Deployment, its own ServiceAccount (the only one
 * allowed to create namespaces), no Service and no ingress. It shares the
 * gateway's image and database, and talks to the gateway only through rows:
 * it writes `stores` progress and the store's `mcp_servers` row, which the
 * gateway's health loop picks up like any other upstream.
 */

// Any constant works; it only has to differ from other advisory locks (Kysely's migrator uses its own).
const LEADER_LOCK = 7_301_042_118;

const env = z
  .object({
    DATABASE_URL: z.string().startsWith("postgres"),
    UPSTREAM_SECRETS_NAMESPACE: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    STORES_TEMPLATE: z.string().optional(),
    STORES_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(900),
    HOSTED_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(600),
    PROVISIONER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
    PROVISIONER_TICK_MS: z.coerce.number().int().min(500).default(5_000),
    PROVISIONER_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  })
  .parse(process.env);

const template = parseStoreTemplate(env.STORES_TEMPLATE);
const files = await loadBootstrapFiles();

const registry = new Registry();
const reconciles = new Counter({
  name: "provisioner_reconcile_total",
  help: "Reconcile passes, by resource (store/hosted), kind (provision/delete) and outcome.",
  labelNames: ["resource", "kind", "outcome"],
  registers: [registry],
});
let leader = false;

// Up before the leader lock: a standby replica is healthy, just idle.
const health = createServer(async (req, res) => {
  if (req.url === "/healthz") return res.writeHead(200).end("ok");
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": registry.contentType });
    return res.end(await registry.metrics());
  }
  res.writeHead(404).end();
});
health.listen(env.PROVISIONER_PORT, "0.0.0.0");

const db = createDb(env.DATABASE_URL, 5);
await waitForDatabase(db, {
  attempts: 50,
  delayMs: 2_000,
  onRetry: (error) => log("warn", "waiting for database", { error }),
});
await migrate(db); // a no-op once the gateway has run them; safe either way (it locks)

new Gauge({
  name: "provisioner_stores",
  help: "Stores by status.",
  labelNames: ["status"],
  registers: [registry],
  async collect() {
    if (!leader) return;
    for (const [status, n] of Object.entries(await storeCounts(db))) this.set({ status }, n);
  },
});
new Gauge({
  name: "provisioner_leader",
  help: "1 on the replica holding the provisioner lock.",
  registers: [registry],
  collect() {
    this.set(leader ? 1 : 0);
  },
});

// One provisioner acts at a time: the lock is held for this connection's
// lifetime, so if the process dies (or the connection drops) another replica
// takes over. Losing the connection means losing the lock - exit rather than
// risk two leaders.
const lockClient = new pg.Client({ connectionString: env.DATABASE_URL });
lockClient.on("error", (err) => {
  log("error", "lost leader connection", { error: err.message });
  process.exit(1);
});
await lockClient.connect();
log("info", "waiting for provisioner lock");
await lockClient.query("select pg_advisory_lock($1)", [LEADER_LOCK]);
leader = true;
log("info", "acquired provisioner lock");

const kube = await K8sClient.inCluster(10_000);
const credentials = new K8sSecretStore({
  apiUrl: "",
  namespace: env.UPSTREAM_SECRETS_NAMESPACE,
  client: kube,
});
const reconciler = new StoreReconciler({
  db,
  kube,
  credentials,
  template,
  files,
  timeoutMs: env.STORES_TIMEOUT_SECONDS * 1000,
  onOutcome: (kind, outcome) => reconciles.inc({ resource: "store", kind, outcome }),
});
const hostedReconciler = new HostedReconciler({
  db,
  kube,
  credentials,
  template,
  secretsNamespace: env.UPSTREAM_SECRETS_NAMESPACE,
  timeoutMs: env.HOSTED_TIMEOUT_SECONDS * 1000,
  onOutcome: (kind, outcome) => reconciles.inc({ resource: "hosted", kind, outcome }),
});
const loop = new ProvisionerLoop(db, reconciler, {
  tickMs: env.PROVISIONER_TICK_MS,
  concurrency: env.PROVISIONER_CONCURRENCY,
});

// Hosted servers get a loop of their own: a slow store bootstrap never
// holds up a hosted server, or the other way round.
const hostedLoop = new ProvisionerLoop(db, hostedReconciler, {
  tickMs: env.PROVISIONER_TICK_MS,
  concurrency: env.PROVISIONER_CONCURRENCY,
  pending: pendingHosted,
});

lockClient.on("notification", (msg) =>
  msg.channel === "hosted_changed" ? hostedLoop.trigger() : loop.trigger(),
);
await lockClient.query("listen stores_changed");
await lockClient.query("listen hosted_changed");
loop.start();
hostedLoop.start();
log("info", "provisioner running", {
  baseDomain: template.baseDomain,
  concurrency: env.PROVISIONER_CONCURRENCY,
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "shutting down", { signal });
    setTimeout(() => process.exit(1), 20_000).unref();
    void (async () => {
      // Finish in-flight passes; each step is safe to redo anyway.
      await Promise.all([loop.stop(), hostedLoop.stop()]);
      await lockClient.end().catch(() => undefined);
      await db.destroy();
      health.close();
      process.exit(0);
    })();
  });
}
