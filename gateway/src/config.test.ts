import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { generateApiKey } from "./crypto/apiKeys.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("loadConfig", () => {
  it("applies defaults and leaves seeding off", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.healthIntervalMs).toBe(15_000);
    expect(config.listTimeoutMs).toBe(5_000);
    expect(config.bootstrapAdmin).toBeUndefined();
    expect(config.seedWoocommerce).toBeUndefined();
  });

  it("reads bootstrap admin and WooCommerce seed settings", () => {
    const { key } = generateApiKey();
    const config = loadConfig({
      ...base,
      BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
      BOOTSTRAP_ADMIN_API_KEY: key,
      SEED_WOOCOMMERCE_URL: "http://mcp.urumi.svc.cluster.local:3000/mcp",
      SEED_WOOCOMMERCE_TOKEN: "t".repeat(64),
    });
    expect(config.bootstrapAdmin).toEqual({
      email: "admin@example.com",
      apiKey: key,
      password: undefined,
    });
    expect(config.seedWoocommerce?.url).toContain("/mcp");
  });

  it("lists every problem in one error", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "mysql://nope",
        ENCRYPTION_KEY: "short",
        BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow(/DATABASE_URL[\s\S]*ENCRYPTION_KEY[\s\S]*BOOTSTRAP_ADMIN_API_KEY/);
  });

  it("rejects a bootstrap key that isn't a gateway key", () => {
    expect(() =>
      loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_API_KEY: "secret" }),
    ).toThrow(/mgw_/);
  });

  it("treats empty strings as unset (optional Secret keys)", () => {
    const config = loadConfig({ ...base, SEED_WOOCOMMERCE_URL: "", SEED_WOOCOMMERCE_TOKEN: "" });
    expect(config.seedWoocommerce).toBeUndefined();
  });

  it("defaults the dashboard auth settings safely", () => {
    const { auth, trustProxyHops } = loadConfig(base);
    expect(auth).toEqual({
      dashboardUrl: undefined,
      publicMcpUrl: undefined,
      allowedOrigins: [], // no cookie-authenticated changes until an origin is configured
      cookieSecure: false,
      sessionTtlMs: 7 * 24 * 3_600_000,
      inviteTtlMs: 7 * 24 * 3_600_000,
    });
    expect(trustProxyHops).toBe(1);
  });

  it("derives the allowed origin from DASHBOARD_URL, or takes an explicit list", () => {
    const derived = loadConfig({ ...base, DASHBOARD_URL: "https://dash.example.com/" });
    expect(derived.auth.dashboardUrl).toBe("https://dash.example.com");
    expect(derived.auth.allowedOrigins).toEqual(["https://dash.example.com"]);

    const explicit = loadConfig({
      ...base,
      DASHBOARD_URL: "https://dash.example.com",
      DASHBOARD_ORIGINS: "http://localhost:5173, https://dash.example.com/app",
    });
    expect(explicit.auth.allowedOrigins).toEqual([
      "http://localhost:5173",
      "https://dash.example.com",
    ]);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["", false],
  ])("COOKIE_SECURE=%j -> %s", (value, expected) => {
    expect(loadConfig({ ...base, COOKIE_SECURE: value }).auth.cookieSecure).toBe(expected);
  });

  it("rejects a non-boolean COOKIE_SECURE and bad dashboard URLs", () => {
    expect(() => loadConfig({ ...base, COOKIE_SECURE: "yes" })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, DASHBOARD_URL: "javascript:alert(1)" })).toThrow(
      /DASHBOARD_URL/,
    );
    expect(() => loadConfig({ ...base, DASHBOARD_ORIGINS: "not a url" })).toThrow(
      /DASHBOARD_ORIGINS/,
    );
  });

  it("reads the bootstrap admin password, which must be long enough and needs the email", () => {
    const { key } = generateApiKey();
    const admin = { BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_API_KEY: key };
    expect(
      loadConfig({ ...base, ...admin, BOOTSTRAP_ADMIN_PASSWORD: "p".repeat(20) }).bootstrapAdmin
        ?.password,
    ).toBe("p".repeat(20));
    expect(() => loadConfig({ ...base, ...admin, BOOTSTRAP_ADMIN_PASSWORD: "short" })).toThrow(
      /BOOTSTRAP_ADMIN_PASSWORD/,
    );
    expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_PASSWORD: "p".repeat(20) })).toThrow(
      /needs BOOTSTRAP_ADMIN_EMAIL/,
    );
  });
});
