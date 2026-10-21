import express, { type Request, type Response } from "express";
import { z } from "zod";
import { FailureLimiter } from "../auth/rateLimit.js";
import type { OAuthConfig } from "../config.js";
import {
  CHALLENGE_PATTERN,
  looksLikeAccessToken,
  looksLikeClientId,
  looksLikeCode,
  looksLikeRefreshToken,
  parseScope,
  redirectUriMatches,
  redirectUriProblem,
  sameResource,
  SCOPES,
  sha256,
  verifyPkce,
} from "../crypto/oauth.js";
import type { Db } from "../db/db.js";
import {
  createRequest,
  getClient,
  issueTokens,
  redeemCode,
  registerClient,
  revokeByTokenHash,
  useRefreshToken,
  type Grant,
} from "../db/oauth.js";
import { log } from "../logger.js";

/** RFC 6749 section 5.2: errors are `{error, error_description}`, not the API's shape. */
class OAuthError extends Error {
  constructor(
    readonly error: string,
    description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** The authorization server's discovery documents (RFC 9728, RFC 8414). */
export function oauthMetadata(cfg: OAuthConfig) {
  const router = express.Router();
  const resource = {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "MCP Gateway",
  };
  // Clients try the path-suffixed URL first (RFC 9728 section 3.1), then the bare one.
  router.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_req, res) => {
      res.json(resource);
    },
  );
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
      token_endpoint: `${cfg.issuer}/oauth/token`,
      registration_endpoint: `${cfg.issuer}/oauth/register`,
      revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    });
  });
  return router;
}

const registerSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/** Registrations per IP an hour: enough for any real client, not for filling the table. */
const REGISTRATIONS = { max: 20, windowMs: 60 * 60_000 };
/** Failed token requests per IP, against guessing codes or refresh tokens. */
const TOKEN_FAILURES = { max: 30, windowMs: 15 * 60_000 };

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * A request we can't safely send back to the client (unknown client, or a
 * redirect URI it didn't register): say so to the user and stop, never
 * redirect (RFC 6749 section 4.1.2.1) - or the gateway is an open redirector.
 */
function errorPage(res: Response, message: string) {
  res
    .status(400)
    .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Authorization failed</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Authorization failed</h1><p>${escapeHtml(message)}</p>` +
        `<p>Go back to the application and try connecting again.</p></body>`,
    );
}

/** The client's redirect URI with the response parameters added; `iss` per RFC 9207. */
export function redirectWith(
  cfg: OAuthConfig,
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: cfg.issuer })) {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Registration, authorization and the token endpoints, mounted at /oauth.
 * Consent itself happens in the dashboard (api/oauth consent routes).
 */
export function oauthServer(db: Db, cfg: OAuthConfig) {
  const router = express.Router();
  const registrations = new FailureLimiter(REGISTRATIONS);
  const tokenFailures = new FailureLimiter(TOKEN_FAILURES);

  const tooMany = (res: Response, waitMs: number) => {
    res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
    throw new OAuthError("temporarily_unavailable", "Too many requests, try again later", 429);
  };

  /** RFC 7591 dynamic client registration. Public clients only: no secret is issued. */
  router.post("/register", express.json({ limit: "20kb" }), async (req, res) => {
    const ipKey = `ip:${req.ip}`;
    const wait = registrations.retryAfterMs(ipKey);
    if (wait > 0) tooMany(res, wait);
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new OAuthError(
        "invalid_client_metadata",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    const body = parsed.data;
    for (const uri of body.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new OAuthError("invalid_redirect_uri", problem);
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
      throw new OAuthError(
        "invalid_client_metadata",
        "Only public clients are supported: token_endpoint_auth_method must be none (use PKCE)",
      );
    }
    const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      throw new OAuthError(
        "invalid_client_metadata",
        "Supported grant types: authorization_code, refresh_token",
      );
    }
    if (body.response_types && body.response_types.some((r) => r !== "code")) {
      throw new OAuthError("invalid_client_metadata", "Supported response types: code");
    }
    registrations.recordFailure(ipKey); // counts every registration, not just failures
    const client = await registerClient(db, {
      name: body.client_name || "MCP client",
      redirectUris: [...new Set(body.redirect_uris)],
    });
    log("info", "oauth client registered", { clientId: client.id, name: client.name });
    res.status(201).json({
      client_id: client.id,
      client_id_issued_at: Math.floor(client.created_at.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  /**
   * The start of the authorization code flow. After the client and redirect
   * URI check out, every problem goes back to the client as an error
   * redirect; a good request is parked and the user is sent to the
   * dashboard to approve it.
   */
  router.get("/authorize", async (req, res) => {
    const q = req.query;
    const clientId = str(q.client_id) ?? "";
    const client = looksLikeClientId(clientId) ? await getClient(db, clientId) : undefined;
    if (!client) {
      errorPage(res, "This application isn't registered with the gateway (unknown client_id).");
      return;
    }
    let redirectUri = str(q.redirect_uri);
    if (redirectUri === undefined && client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    }
    if (!redirectUri || !redirectUriMatches(client.redirect_uris, redirectUri)) {
      errorPage(res, "The redirect_uri doesn't match any the application registered.");
      return;
    }

    const state = str(q.state) ?? null;
    const fail = (error: string, description: string) =>
      res.redirect(
        302,
        redirectWith(cfg, redirectUri, { error, error_description: description, state }),
      );

    if (q.response_type !== "code") {
      return fail("unsupported_response_type", "Only response_type=code is supported");
    }
    const challenge = str(q.code_challenge);
    if (!challenge || !CHALLENGE_PATTERN.test(challenge)) {
      return fail("invalid_request", "PKCE is required: send a code_challenge");
    }
    if (q.code_challenge_method !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256");
    }
    const scope = parseScope(str(q.scope));
    if (!Array.isArray(scope)) {
      return fail("invalid_scope", `Unknown scope: ${scope.unknown.join(" ")}`);
    }
    // RFC 8707: a token is only ever for this gateway's /mcp, so a client
    // asking for any other audience is refused rather than silently retargeted.
    const resource = str(q.resource);
    if (resource !== undefined && !sameResource(resource, cfg.resource)) {
      return fail("invalid_target", `This server only issues tokens for ${cfg.resource}`);
    }

    const id = await createRequest(
      db,
      {
        clientId: client.id,
        redirectUri,
        state,
        codeChallenge: challenge,
        scope,
        resource: cfg.resource,
      },
      cfg.codeTtlMs,
    );
    const consent = new URL(cfg.consentUrl);
    consent.searchParams.set("req", id);
    res.redirect(302, consent.toString());
  });

  const formOrJson = [
    express.urlencoded({ extended: false, limit: "10kb" }),
    express.json({ limit: "10kb" }),
  ];

  /** RFC 6749 section 3.2, with the OAuth 2.1 rules: PKCE always, refresh tokens rotate. */
  router.post("/token", ...formOrJson, async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    const ipKey = `ip:${req.ip}`;
    const wait = tokenFailures.retryAfterMs(ipKey);
    if (wait > 0) tooMany(res, wait);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const clientId = str(body.client_id) ?? "";
      const client = looksLikeClientId(clientId) ? await getClient(db, clientId) : undefined;
      if (!client) throw new OAuthError("invalid_client", "Unknown client_id", 401);

      let grant: Grant;
      let accessScope: string[] | undefined;
      if (body.grant_type === "authorization_code") {
        grant = await exchangeCode(body, client.id);
      } else if (body.grant_type === "refresh_token") {
        ({ grant, accessScope } = await refresh(body, client.id));
      } else {
        throw new OAuthError(
          "unsupported_grant_type",
          "grant_type must be authorization_code or refresh_token",
        );
      }
      const issued = await issueTokens(
        db,
        grant,
        { accessMs: cfg.accessTtlMs, refreshMs: cfg.refreshTtlMs },
        accessScope,
      );
      res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: issued.scope.join(" "),
      });
    } catch (err) {
      if (err instanceof OAuthError) tokenFailures.recordFailure(ipKey);
      throw err;
    }
  });

  async function exchangeCode(body: Record<string, unknown>, clientId: string): Promise<Grant> {
    const code = str(body.code) ?? "";
    const verifier = str(body.code_verifier);
    if (!verifier) throw new OAuthError("invalid_request", "code_verifier is required");
    if (!looksLikeCode(code)) throw new OAuthError("invalid_grant", "Invalid authorization code");
    // Redeemed first, whatever else is wrong: a code is good for one attempt.
    const r = await redeemCode(db, sha256(code));
    if (r.kind === "replayed") {
      log("warn", "oauth code replayed; its tokens are revoked", { clientId });
    }
    if (r.kind !== "ok") {
      throw new OAuthError("invalid_grant", "Invalid, expired or already used authorization code");
    }
    if (r.grant.clientId !== clientId) {
      throw new OAuthError("invalid_grant", "This code was issued to another client");
    }
    const redirectUri = str(body.redirect_uri);
    if (redirectUri !== undefined && redirectUri !== r.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request");
    }
    if (!verifyPkce(verifier, r.codeChallenge)) {
      throw new OAuthError("invalid_grant", "code_verifier doesn't match the code_challenge");
    }
    const resource = str(body.resource);
    if (resource !== undefined && !sameResource(resource, r.grant.resource)) {
      throw new OAuthError("invalid_target", `This code is for ${r.grant.resource}`);
    }
    return r.grant;
  }

  async function refresh(
    body: Record<string, unknown>,
    clientId: string,
  ): Promise<{ grant: Grant; accessScope?: string[] }> {
    const token = str(body.refresh_token) ?? "";
    if (!looksLikeRefreshToken(token))
      throw new OAuthError("invalid_grant", "Invalid refresh token");
    const r = await useRefreshToken(db, sha256(token), clientId);
    if (r.kind === "replayed") {
      log("warn", "oauth refresh token reused; the grant is revoked", { clientId });
    }
    if (r.kind !== "ok") {
      throw new OAuthError(
        "invalid_grant",
        "Invalid, expired, revoked or already used refresh token",
      );
    }
    // A refresh may ask for less than was granted (for this access token
    // only: the new refresh token keeps the grant); asking for more is refused.
    const asked = str(body.scope);
    let accessScope: string[] | undefined;
    if (asked !== undefined && asked.trim() !== "") {
      const scope = parseScope(asked);
      if (!Array.isArray(scope) || scope.some((s) => !r.grant.scope.includes(s))) {
        throw new OAuthError("invalid_scope", "A refresh can't add scopes that weren't granted");
      }
      // As on the consent page, writing implies reading.
      if (scope.includes("mcp:write")) scope.push("mcp:read");
      accessScope = SCOPES.filter((s) => scope.includes(s));
    }
    const resource = str(body.resource);
    if (resource !== undefined && !sameResource(resource, r.grant.resource)) {
      throw new OAuthError("invalid_target", `This grant is for ${r.grant.resource}`);
    }
    return { grant: r.grant, accessScope };
  }

  /**
   * RFC 7009. Either token ends the whole grant. Always 200, even for an
   * unknown token, so the endpoint doesn't tell anyone which tokens exist.
   */
  router.post("/revoke", ...formOrJson, async (req, res) => {
    const token = str((req.body ?? {}).token) ?? "";
    if (looksLikeAccessToken(token) || looksLikeRefreshToken(token)) {
      await revokeByTokenHash(db, sha256(token));
    }
    res.status(200).end();
  });

  router.use(
    // Express recognises error handlers by their four parameters.
    (err: unknown, _req: Request, res: Response, next: (e: unknown) => void) => {
      if (err instanceof OAuthError) {
        res.status(err.status).json({ error: err.error, error_description: err.message });
        return;
      }
      const status = (err as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        res.status(400).json({ error: "invalid_request", error_description: "Malformed request" });
        return;
      }
      next(err);
    },
  );
  return router;
}
