import type { NextFunction, Request, Response } from "express";
import { hashApiKey, looksLikeApiKey } from "../crypto/apiKeys.js";
import { findPrincipalByKeyHash, touchApiKey, type Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import { log } from "../logger.js";

/** The authenticated caller, set by requireApiKey. */
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

/**
 * `Authorization: Bearer mgw_...` -> the key's user. Looked up by SHA-256 hash
 * on every request (no cache), so revoking a key or disabling a user takes
 * effect on the very next call. Malformed values are rejected before any DB
 * query. The same message for every failure avoids telling an attacker
 * whether a key exists but was revoked.
 */
export function requireApiKey(db: Db, style: ErrorStyle) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const principal = looksLikeApiKey(key)
      ? await findPrincipalByKeyHash(db, hashApiKey(key))
      : undefined;
    if (!principal) {
      sendError(res, style, 401, "Missing, invalid or revoked API key");
      return;
    }
    res.locals.principal = principal;
    touchApiKey(db, principal.keyId!).catch((err) =>
      log("warn", "could not record key use", { error: String(err) }),
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
