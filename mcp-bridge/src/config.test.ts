import { describe, expect, it } from "vitest";
import { childEnv, loadConfig } from "./config.js";

const token = "t".repeat(32);
const argv = (...rest: string[]) => ["node", "index.js", ...rest];

describe("loadConfig", () => {
  it("takes the command after --, and defaults", () => {
    expect(
      loadConfig(argv("--", "uvx", "mcp-server-time", "--tz", "UTC"), {
        BRIDGE_AUTH_TOKEN: token,
      }),
    ).toEqual({
      command: "uvx",
      args: ["mcp-server-time", "--tz", "UTC"],
      authToken: token,
      port: 8080,
      timeoutMs: 60_000,
      startupTimeoutMs: 180_000,
    });
  });

  it("refuses a missing command, a short token and a bad port", () => {
    expect(() => loadConfig(argv(), { BRIDGE_AUTH_TOKEN: token })).toThrow(/usage/);
    expect(() => loadConfig(argv("--"), { BRIDGE_AUTH_TOKEN: token })).toThrow(/usage/);
    expect(() => loadConfig(argv("--", "x"), {})).toThrow(/BRIDGE_AUTH_TOKEN/);
    expect(() => loadConfig(argv("--", "x"), { BRIDGE_AUTH_TOKEN: "short" })).toThrow(
      /BRIDGE_AUTH_TOKEN/,
    );
    expect(() =>
      loadConfig(argv("--", "x"), { BRIDGE_AUTH_TOKEN: token, BRIDGE_PORT: "99999" }),
    ).toThrow(/BRIDGE_PORT/);
    expect(() =>
      loadConfig(argv("--", "x"), { BRIDGE_AUTH_TOKEN: token, BRIDGE_TIMEOUT_MS: "soon" }),
    ).toThrow(/BRIDGE_TIMEOUT_MS/);
  });
});

describe("childEnv", () => {
  it("passes the image's environment but none of the bridge's settings", () => {
    expect(
      childEnv({ PATH: "/bin", API_KEY: "k", BRIDGE_AUTH_TOKEN: token, BRIDGE_PORT: "1" }),
    ).toEqual({ PATH: "/bin", API_KEY: "k" });
  });
});
