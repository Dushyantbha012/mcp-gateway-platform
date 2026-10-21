import type { NextFunction, Request, Response } from "express";
import { hashApiKey, looksLikeApiKey } from "../crypto/apiKeys.js";
import { looksLikeAccessToken, sameResource, sha256 } from "../crypto/oauth.js";
import { hashToken, looksLikeToken } from "../crypto/tokens.js";
import { findPrincipalByKeyHash, touchApiKey, type Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import { findPrincipalByAccessHash, touchAccessToken } from "../db/oauth.js";
import { findPrincipalBySessionHash, touchSession } from "../db/sessions.js";
import { log } from "../logger.js";

/** The authenticated caller, set by requireAuth. */
export function principalOf(res: Response): Principal {
  return res.locals.principal as Principal;
}

type ErrorStyle = "jsonrpc" | "rest";

function sendError(
  res: Response,
  style: ErrorStyle,
  status: 401 | 403,
  message: string,
  oauth?: { resourceMetadataUrl: string; error: boolean } | false,
) {
  if (status === 401) {
    // With OAuth on, a client that sent no credentials gets just the
    // metadata pointer; one whose token failed also gets error=invalid_token
    // (RFC 6750 section 3.1), so it knows to refresh or sign in again.
    res.set(
      "WWW-Authenticate",
      oauth
        ? `Bearer resource_metadata="${oauth.resourceMetadataUrl}"` +
            (oauth.error ? ', error="invalid_token"' : "")
        : 'Bearer realm="mcp-gateway"',
    );
  }
  if (style === "jsonrpc") {
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
  } else {
    res
      .status(status)
      .json({ error: { code: status === 401 ? "unauthorized" : "forbidden", message } });
  }
}

export const SESSION_COOKIE = "mgw_session";

/** One cookie's value from the Cookie header (no cookie-parser dependency for one name). */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests, on top of SameSite=Strict:
 * a state-changing request must come from a page on an allowed origin.
 * Browsers always send Origin on POST/PATCH/DELETE from fetch, and a page on
 * another site can't forge it. A missing Origin is rejected too (fail closed).
 */
export function isAllowedOrigin(
  method: string,
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  return origin !== undefined && allowed.includes(origin);
}

/** For the unauthenticated auth endpoints (login, accept invite): same Origin rule. */
export function requireAllowedOrigin(allowedOrigins: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedOrigin(req.method, req.headers.origin, allowedOrigins)) {
      sendError(res, "rest", 403, "Cross-origin request rejected");
      return;
    }
    next();
  };
}

export interface AuthOptions {
  style: ErrorStyle;
  /** Accept the dashboard's session cookie as well as API keys. */
  allowSession: boolean;
  allowedOrigins?: readonly string[];
  /**
   * Also accept OAuth access tokens issued for `resource`, and point clients
   * without a valid token at the protected-resource metadata (RFC 9728
   * section 5.1), which is how an MCP client discovers where to sign in.
   */
  oauth?: { resource: string; resourceMetadataUrl: string };
}

/**
 * Authenticates every request, with no cache, so revoking a key, logging out
 * or disabling a user takes effect on the very next call.
 *
 * - `Authorization: Bearer mgw_...` -> that API key's user (MCP clients,
 *   scripts). If the header is present it must be valid; a cookie doesn't
 *   rescue a bad key.
 * - otherwise, if allowed, the `mgw_session` cookie -> that session's user
 *   (the dashboard), with the Origin check for changes.
 *
 * Malformed values are rejected before any DB query. The same message for
 * every failure avoids telling an attacker whether a key exists but was
 * revoked.
 */
export function requireAuth(db: Db, opts: AuthOptions) {
  const allowedOrigins = opts.allowedOrigins ?? [];
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (header !== undefined || !opts.allowSession) {
      const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      if (opts.oauth && looksLikeAccessToken(key)) {
        const found = await findPrincipalByAccessHash(db, sha256(key));
        // A token for another resource is refused, so one minted for some
        // other service can't be replayed here (RFC 8707, audience check).
        if (!found || !sameResource(found.resource, opts.oauth.resource)) {
          sendError(res, opts.style, 401, "Invalid, expired or revoked access token", {
            ...opts.oauth,
            error: true,
          });
          return;
        }
        const principal: Principal = {
          userId: found.userId,
          email: found.email,
          role: found.role,
          authMethod: "oauth",
          keyId: null,
          sessionId: null,
          oauth: found.oauth,
        };
        res.locals.principal = principal;
        touchAccessToken(db, principal.oauth!.tokenId).catch((err) =>
          log("warn", "could not record token use", { error: String(err) }),
        );
        next();
        return;
      }
      const principal = looksLikeApiKey(key)
        ? await findPrincipalByKeyHash(db, hashApiKey(key))
        : undefined;
      if (!principal) {
        sendError(
          res,
          opts.style,
          401,
          opts.oauth
            ? "Missing, invalid or revoked API key or access token"
            : "Missing, invalid or revoked API key",
          opts.oauth && { ...opts.oauth, error: header !== undefined },
        );
        return;
      }
      res.locals.principal = principal;
      touchApiKey(db, principal.keyId!).catch((err) =>
        log("warn", "could not record key use", { error: String(err) }),
      );
      next();
      return;
    }

    const token = readCookie(req, SESSION_COOKIE) ?? "";
    const principal = looksLikeToken(token)
      ? await findPrincipalBySessionHash(db, hashToken(token))
      : undefined;
    if (!principal) {
      sendError(res, opts.style, 401, "Not logged in, or the session has expired");
      return;
    }
    if (!isAllowedOrigin(req.method, req.headers.origin, allowedOrigins)) {
      sendError(res, opts.style, 403, "Cross-origin request rejected");
      return;
    }
    res.locals.principal = principal;
    touchSession(db, principal.sessionId!).catch((err) =>
      log("warn", "could not record session use", { error: String(err) }),
    );
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (principalOf(res).role !== "admin") {
    sendError(res, "rest", 403, "Admin role required");
    return;
  }
  next();
}

/** For endpoints that only make sense for a browser session (logout, change password). */
export function requireSession(req: Request, res: Response, next: NextFunction) {
  if (principalOf(res).authMethod !== "session") {
    sendError(res, "rest", 403, "This endpoint needs a dashboard session");
    return;
  }
  next();
}
