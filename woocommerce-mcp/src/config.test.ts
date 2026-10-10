import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = {
  WC_BASE_URL: "http://wordpress.urumi.svc.cluster.local/",
  WC_CONSUMER_KEY: "ck_abc",
  WC_CONSUMER_SECRET: "cs_abc",
  MCP_AUTH_TOKEN: "x".repeat(32),
};

describe("loadConfig", () => {
  it("applies defaults and trims trailing slashes", () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.wc.timeoutMs).toBe(8000);
    expect(config.wc.baseUrl).toBe("http://wordpress.urumi.svc.cluster.local");
    expect(config.wc.signingUrl).toBe(config.wc.baseUrl);
  });

  it("uses WC_SIGNING_URL when given", () => {
    const config = loadConfig({ ...valid, WC_SIGNING_URL: "http://store.local.test" });
    expect(config.wc.signingUrl).toBe("http://store.local.test");
  });

  it("lists every problem in one error", () => {
    expect(() =>
      loadConfig({ WC_BASE_URL: "not a url", WC_CONSUMER_KEY: "abc", MCP_AUTH_TOKEN: "short" }),
    ).toThrowError(
      /WC_BASE_URL[\s\S]*WC_CONSUMER_KEY[\s\S]*WC_CONSUMER_SECRET[\s\S]*MCP_AUTH_TOKEN/,
    );
  });

  it("rejects a non-numeric timeout", () => {
    expect(() => loadConfig({ ...valid, WC_TIMEOUT_MS: "soon" })).toThrowError(/WC_TIMEOUT_MS/);
  });
});
