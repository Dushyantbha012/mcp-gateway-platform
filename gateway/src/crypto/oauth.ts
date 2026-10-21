import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The pure parts of the gateway's OAuth: token formats, PKCE, redirect URI
 * rules and scopes. Like API keys, every token is 256 random bits stored
 * only as SHA-256.
 *
 *   mgc_<22>  client id (public, not a secret)
 *   mgo_<43>  access token (1 hour)
 *   mgr_<43>  refresh token (30 days, rotated on every use)
 *   <43>      authorization code (10 minutes, single use)
 */
export const SCOPES = ["mcp:read", "mcp:write"] as const;
export type Scope = (typeof SCOPES)[number];

const ACCESS_PATTERN = /^mgo_[A-Za-z0-9_-]{43}$/;
const REFRESH_PATTERN = /^mgr_[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_PATTERN = /^mgc_[A-Za-z0-9_-]{22}$/;
/** RFC 7636 section 4.1. */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

export interface Secret {
  value: string;
  hash: Buffer;
}
const secret = (prefix: string): Secret => {
  const value = prefix + randomBytes(32).toString("base64url");
  return { value, hash: sha256(value) };
};
export const newAccessToken = () => secret("mgo_");
export const newRefreshToken = () => secret("mgr_");
export const newAuthorizationCode = () => secret("");
export const newClientId = () => `mgc_${randomBytes(16).toString("base64url")}`;

export const looksLikeAccessToken = (v: string) => ACCESS_PATTERN.test(v);
export const looksLikeRefreshToken = (v: string) => REFRESH_PATTERN.test(v);
export const looksLikeCode = (v: string) => CODE_PATTERN.test(v);
export const looksLikeClientId = (v: string) => CLIENT_ID_PATTERN.test(v);

/** PKCE S256: BASE64URL(SHA256(verifier)) must equal the challenge sent to /authorize. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier) || !CHALLENGE_PATTERN.test(challenge)) return false;
  const expected = Buffer.from(sha256(verifier).toString("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Which redirect URIs a client may register: https anywhere, or http on the
 * loopback interface only (native apps and CLIs, RFC 8252 section 7.3).
 * Returns why one is refused, or null.
 */
export function redirectUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${uri} is not a URL`;
  }
  if (url.hash || uri.includes("#")) return `${uri} must not contain a fragment`;
  if (url.username || url.password) return `${uri} must not contain credentials`;
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return `${uri} must be https, or http on 127.0.0.1, [::1] or localhost`;
}

/**
 * Exact match against a registered URI, except that a loopback http URI may
 * use any port (RFC 8252 section 7.3: the client picks a free one at runtime).
 */
export function redirectUriMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) return false;
  return registered.some((r) => {
    const reg = new URL(r);
    return (
      reg.protocol === "http:" &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

/**
 * A space-separated scope parameter. Absent = everything (the user can still
 * narrow it on the consent page). Unknown scopes are an error, not ignored,
 * so a client never believes it holds something it doesn't.
 */
export function parseScope(param: string | undefined): Scope[] | { unknown: string[] } {
  if (param === undefined || param.trim() === "") return [...SCOPES];
  const asked = [...new Set(param.trim().split(/\s+/))];
  const unknown = asked.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) return { unknown };
  // mcp:write without mcp:read makes no sense (you can't call a tool you can't list).
  const scopes = asked as Scope[];
  return scopes.includes("mcp:write") && !scopes.includes("mcp:read")
    ? ["mcp:read", ...scopes]
    : scopes;
}

/** The resource indicator (RFC 8707) names this gateway's MCP endpoint; a trailing slash is the same resource. */
export const sameResource = (a: string, b: string) =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
