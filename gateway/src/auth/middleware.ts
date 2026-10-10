import type { NextFunction, Request, Response } from "express";
import { hashApiKey, looksLikeApiKey } from "../crypto/apiKeys.js";
import { hashToken, looksLikeToken } from "../crypto/tokens.js";
import { findPrincipalByKeyHash, touchApiKey, type Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import { findPrincipalBySessionHash, touchSession } from "../db/sessions.js";
import { log } from "../logger.js";

/** The authenticated caller, set by requireAuth. */
export function principalOf(res: Response): Principal {
  return res.locals.principal as Principal;
}

type ErrorStyle = "jsonrpc" | "rest";

function sendError(res: Response, style: ErrorStyle, status: 401 | 403, message: string) {
  if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="mcp-gateway"');
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
      const principal = looksLikeApiKey(key)
        ? await findPrincipalByKeyHash(db, hashApiKey(key))
        : undefined;
      if (!principal) {
        sendError(res, opts.style, 401, "Missing, invalid or revoked API key");
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
