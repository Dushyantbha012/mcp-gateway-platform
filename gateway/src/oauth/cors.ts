import type { NextFunction, Request, Response } from "express";

/**
 * CORS for the endpoints a browser-based MCP client (MCP Inspector, claude.ai)
 * calls directly: discovery, registration, token, revoke and /mcp itself.
 * `*` is safe here because none of them takes a cookie - each authenticates
 * with a bearer token or a PKCE verifier the calling page already holds.
 * The dashboard's cookie-authenticated /api never gets these headers.
 */
export function publicCors(req: Request, res: Response, next: NextFunction) {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    // The client needs WWW-Authenticate to find the authorization server.
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    "Access-Control-Max-Age": "600",
  });
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}
