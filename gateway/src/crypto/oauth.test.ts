import { describe, expect, it } from "vitest";
import {
  looksLikeAccessToken,
  looksLikeClientId,
  looksLikeCode,
  looksLikeRefreshToken,
  newAccessToken,
  newAuthorizationCode,
  newClientId,
  newRefreshToken,
  parseScope,
  redirectUriMatches,
  redirectUriProblem,
  sameResource,
  sha256,
  verifyPkce,
} from "./oauth.js";

describe("token formats", () => {
  it("are prefixed, 256 random bits, and carry their SHA-256", () => {
    const a = newAccessToken();
    const r = newRefreshToken();
    const c = newAuthorizationCode();
    expect(looksLikeAccessToken(a.value)).toBe(true);
    expect(looksLikeRefreshToken(r.value)).toBe(true);
    expect(looksLikeCode(c.value)).toBe(true);
    expect(looksLikeClientId(newClientId())).toBe(true);
    for (const s of [a, r, c]) expect(s.hash.equals(sha256(s.value))).toBe(true);
    expect(newAccessToken().value).not.toBe(a.value);
  });

  it("aren't mistaken for each other", () => {
    expect(looksLikeAccessToken(newRefreshToken().value)).toBe(false);
    expect(looksLikeRefreshToken(newAccessToken().value)).toBe(false);
    expect(looksLikeCode(newAccessToken().value)).toBe(false);
    expect(looksLikeClientId("mgc_short")).toBe(false);
  });
});

describe("verifyPkce", () => {
  // RFC 7636 appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepts the RFC's example pair", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("refuses a different verifier, or one outside the RFC's grammar", () => {
    expect(verifyPkce(verifier.replace("d", "e"), challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
    expect(verifyPkce(`${verifier}!`, challenge)).toBe(false);
    expect(verifyPkce(verifier, "not-a-challenge")).toBe(false);
  });
});

describe("redirectUriProblem", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "http://127.0.0.1:33418/callback",
    "http://localhost:6274/oauth/callback",
    "http://[::1]:8080/cb",
  ])("allows %s", (uri) => {
    expect(redirectUriProblem(uri)).toBeNull();
  });

  it.each([
    ["http://example.com/cb", /must be https/],
    ["http://127.0.0.1.evil.com/cb", /must be https/],
    ["myapp://callback", /must be https/],
    ["javascript:alert(1)", /must be https/],
    ["https://example.com/cb#frag", /fragment/],
    ["https://user:pw@example.com/cb", /credentials/],
    ["not a url", /not a URL/],
  ])("refuses %s", (uri, problem) => {
    expect(redirectUriProblem(uri)).toMatch(problem);
  });
});

describe("redirectUriMatches", () => {
  it("is an exact match for https", () => {
    const reg = ["https://app.example.com/cb"];
    expect(redirectUriMatches(reg, "https://app.example.com/cb")).toBe(true);
    expect(redirectUriMatches(reg, "https://app.example.com/cb/")).toBe(false);
    expect(redirectUriMatches(reg, "https://app.example.com/cb?x=1")).toBe(false);
    expect(redirectUriMatches(reg, "https://app.example.com:8443/cb")).toBe(false);
  });

  it("lets a loopback URI use any port, but nothing else may differ", () => {
    const reg = ["http://127.0.0.1:1234/callback"];
    expect(redirectUriMatches(reg, "http://127.0.0.1:55555/callback")).toBe(true);
    expect(redirectUriMatches(reg, "http://127.0.0.1/callback")).toBe(true);
    expect(redirectUriMatches(reg, "http://127.0.0.1:55555/other")).toBe(false);
    expect(redirectUriMatches(reg, "http://localhost:55555/callback")).toBe(false);
    expect(redirectUriMatches(reg, "https://127.0.0.1:55555/callback")).toBe(false);
    expect(redirectUriMatches(reg, "garbage")).toBe(false);
  });
});

describe("parseScope", () => {
  it("defaults to every scope", () => {
    expect(parseScope(undefined)).toEqual(["mcp:read", "mcp:write"]);
    expect(parseScope("  ")).toEqual(["mcp:read", "mcp:write"]);
  });

  it("keeps what was asked, de-duplicated, and implies read with write", () => {
    expect(parseScope("mcp:read")).toEqual(["mcp:read"]);
    expect(parseScope("mcp:read  mcp:read")).toEqual(["mcp:read"]);
    expect(parseScope("mcp:write")).toEqual(["mcp:read", "mcp:write"]);
  });

  it("reports unknown scopes instead of dropping them", () => {
    expect(parseScope("mcp:read admin")).toEqual({ unknown: ["admin"] });
  });
});

it("sameResource ignores a trailing slash only", () => {
  expect(sameResource("https://gw.example.com/mcp", "https://gw.example.com/mcp/")).toBe(true);
  expect(sameResource("https://gw.example.com/mcp", "https://gw.example.com/")).toBe(false);
  expect(sameResource("https://gw.example.com/mcp", "https://evil.example.com/mcp")).toBe(false);
});
