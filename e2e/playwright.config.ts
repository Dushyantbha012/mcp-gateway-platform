import { defineConfig, devices } from "@playwright/test";
import { CONTROL_PORT, DASHBOARD_ORIGIN, DASHBOARD_PORT, GATEWAY_PORT } from "./ports.js";

/**
 * Browser tests against the real dashboard build and the real gateway app
 * (harness.ts: fresh Postgres DB, fake upstreams). Needs TEST_DATABASE_URL.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://gateway_test:gateway_test@localhost:5433/gateway_test npm run test:e2e
 */
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "tests",
  // One shared gateway + DB: run serially so tests that make an upstream
  // misbehave can't affect another test mid-flight.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: DASHBOARD_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx harness.ts",
      url: `http://127.0.0.1:${CONTROL_PORT}/state`,
      reuseExistingServer: false, // always a fresh database
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      // The production build, served by Vite with /api proxied to the
      // harness gateway - the same shape as the cluster's Ingress.
      command: `npm run build && npx vite preview --port ${DASHBOARD_PORT} --strictPort`,
      cwd: "../dashboard",
      url: DASHBOARD_ORIGIN,
      reuseExistingServer: !CI,
      timeout: 120_000,
      env: { GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}` },
    },
  ],
});
