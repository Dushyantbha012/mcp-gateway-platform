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
    expect(config.bootstrapAdmin).toEqual({ email: "admin@example.com", apiKey: key });
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
});
