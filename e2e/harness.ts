/**
 * E2E harness: the real gateway app (same wiring as gateway/src/index.ts)
 * against a fresh, throwaway Postgres database, with two real MCP fake
 * upstreams, so the browser tests exercise the whole stack - only the
 * upstreams are fake.
 *
 *   TEST_DATABASE_URL=postgres://... npx tsx e2e/harness.ts
 *
 * Playwright starts it (playwright.config.ts `webServer`). Besides the
 * gateway it serves a small control API the tests use to read the seeded
 * credentials and to make a fake upstream misbehave.
 */
import express from "express";
import { createApp } from "../gateway/src/app.js";
import type { LlmClient, LlmReply, LlmRequest } from "../gateway/src/chat/types.js";
import { generateApiKey } from "../gateway/src/crypto/apiKeys.js";
import { MemoryCredentialStore } from "../gateway/src/credentials/store.js";
import { insertServer } from "../gateway/src/db/servers.js";
import { seed } from "../gateway/src/seed.js";
import { startFakeUpstream, type Behavior } from "../gateway/src/test/fakeUpstream.js";
import { createTestDatabase, hasTestDb } from "../gateway/src/test/testDb.js";
import { HealthChecker } from "../gateway/src/upstreams/health.js";
import { policyFrom } from "../gateway/src/security/ssrf.js";
import { UpstreamRegistry } from "../gateway/src/upstreams/registry.js";
import { ToolRouter } from "../gateway/src/upstreams/router.js";
import { CONTROL_PORT, DASHBOARD_ORIGIN, GATEWAY_PORT } from "./ports.js";

if (!hasTestDb) {
  console.error("TEST_DATABASE_URL is required (docker compose -f docker-compose.test.yml up -d)");
  process.exit(1);
}

const admin = {
  email: "admin@e2e.test",
  password: "e2e-admin-password",
  apiKey: generateApiKey().key,
};

const t = await createTestDatabase();
const credentials = new MemoryCredentialStore();
await seed(t.db, credentials, { bootstrapAdmin: admin } as Parameters<typeof seed>[2]);

// "alpha" is pre-registered (like WooCommerce in the real deployment);
// "beta" is for the tests to add through the UI, with a credential.
const fakes = {
  alpha: await startFakeUpstream({ toolNames: ["list_orders", "get_order"] }),
  beta: await startFakeUpstream({ toolNames: ["search_docs"] }),
};
await insertServer(t.db, {
  slug: "alpha",
  name: "Alpha Shop",
  url: fakes.alpha.url,
  timeout_ms: 2_000,
});

// Real SSRF policy; only the fakes' own address (127.0.0.1) is allowlisted.
const ssrf = policyFrom(["127.0.0.1"]);
const registry = new UpstreamRegistry(credentials, {
  maxResultBytes: 1_000_000,
  ssrf,
});
// Fast health loop so status changes show up within a test's patience.
const health = new HealthChecker(t.db, registry, { intervalMs: 1_000, listTimeoutMs: 1_500 });
const router = new ToolRouter(t.db, registry);
await health.checkAll();
health.start();

/**
 * A rule-based stand-in for Gemini, so the browser tests are deterministic and
 * free: it picks a tool from the user's words, and once it has a tool result,
 * answers with it. "slow" never answers (for the Stop button).
 */
const fakeLlm: LlmClient = {
  async generate(req: LlmRequest): Promise<LlmReply> {
    const last = req.turns.at(-1);
    if (last?.role === "tool") {
      return { text: `Tool said: ${last.results.map((r) => r.output).join(" | ")}`, calls: [] };
    }
    const asked = last?.role === "user" ? last.text.toLowerCase() : "";
    const call = (name: string, args: Record<string, unknown> = {}): LlmReply => ({
      text: "",
      calls: [{ id: `call_${Date.now()}`, name, args }],
    });
    if (asked.includes("slow")) {
      return new Promise((_, reject) =>
        req.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    if (asked.includes("markdown")) {
      return {
        text: "Here are **2 products**:\n\n1. **Mug** - $12.00\n2. **Tee** - $25.00\n\n| SKU | Stock |\n|---|---|\n| DEMO-MUG | 10 |\n\nUse `list_products` for more.",
        calls: [],
      };
    }
    if (asked.includes("orders")) return call("alpha__list_orders", { value: "today" });
    if (asked.includes("missing")) return call("alpha__fail");
    return { text: "Hello from the fake model.", calls: [] };
  },
};

const app = createApp({
  db: t.db,
  credentials,
  ssrf,
  registry,
  health,
  router,
  chat: { llm: fakeLlm, turnsPerMinute: 1000, limits: { turnTimeoutMs: 20_000 } },
  config: {
    trustProxyHops: 1,
    // No provisioner runs here: stores stay where the API puts them.
    stores: { enabled: true, maxPerUser: 2, timeoutSeconds: 900 },
    auth: {
      dashboardUrl: DASHBOARD_ORIGIN,
      publicMcpUrl: `http://127.0.0.1:${GATEWAY_PORT}/mcp`,
      allowedOrigins: [DASHBOARD_ORIGIN],
      cookieSecure: false,
      sessionTtlMs: 3_600_000,
      inviteTtlMs: 3_600_000,
    },
  },
});
const gateway = app.listen(GATEWAY_PORT, "127.0.0.1");

const control = express();
control.use(express.json());
control.get("/state", (_req, res) => {
  res.json({
    admin,
    gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
    fakes: Object.fromEntries(Object.entries(fakes).map(([k, f]) => [k, f.url])),
  });
});
control.post("/fakes/:name/behavior", (req, res) => {
  const fake = fakes[req.params.name as keyof typeof fakes];
  if (!fake) return void res.status(404).end();
  fake.behavior = req.body.behavior as Behavior;
  res.json({ behavior: fake.behavior });
});
/** The Authorization headers a fake has received - proves which credential the gateway sent. */
control.get("/fakes/:name/auth", (req, res) => {
  const fake = fakes[req.params.name as keyof typeof fakes];
  if (!fake) return void res.status(404).end();
  res.json([...new Set(fake.requests.map((h) => h.authorization ?? null))]);
});
const controlServer = control.listen(CONTROL_PORT, "127.0.0.1");
console.log(`e2e harness: gateway :${GATEWAY_PORT}, control :${CONTROL_PORT}, db ${t.url}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    setTimeout(() => process.exit(1), 5_000).unref();
    gateway.closeAllConnections();
    controlServer.closeAllConnections();
    gateway.close();
    controlServer.close();
    await health.stop();
    await registry.closeAll();
    await Promise.all(Object.values(fakes).map((f) => f.close()));
    await t.drop();
    process.exit(0);
  });
}
