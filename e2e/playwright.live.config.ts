import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke test against the live k3d (or VPS) deployment, run by
 * scripts/verify-phase4.sh. No harness: the real gateway, the real store's
 * MCP server, and kubectl to kill it.
 *
 *   E2E_BASE_URL=http://dashboard.local.test E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
 *     npm run test:live -w e2e
 */
export default defineConfig({
  testDir: "live",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://dashboard.local.test",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
