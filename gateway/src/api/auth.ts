import express, { type Request, type Response } from "express";
import { z } from "zod";
import { readCookie, requireAllowedOrigin, SESSION_COOKIE } from "../auth/middleware.js";
import { FailureLimiter } from "../auth/rateLimit.js";
import type { AuthConfig } from "../config.js";
import {
  burnPasswordCheck,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  verifyPassword,
} from "../crypto/passwords.js";
import { hashToken, looksLikeToken } from "../crypto/tokens.js";
import type { Db } from "../db/db.js";
import { acceptInvite, findValidInvite } from "../db/invites.js";
import { createSession, deleteSession, findPrincipalBySessionHash } from "../db/sessions.js";
import { findUserByEmail } from "../db/users.js";
import { log } from "../logger.js";
import { HttpError, parse } from "./errors.js";
import { passwordSchema, userView } from "./users.js";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(MAX_PASSWORD_LENGTH),
});

const acceptSchema = z.object({ password: passwordSchema });

const LOGIN_FAILURES = { max: 10, windowMs: 15 * 60_000 };

/** Sets the dashboard session cookie. HttpOnly: page scripts (and so XSS) can't read it. */
export function setSessionCookie(res: Response, auth: AuthConfig, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: auth.cookieSecure,
    // Only the REST API needs it; never sent to /mcp, so a browser can't be
    // tricked into making MCP calls with it.
    path: "/api",
    maxAge: auth.sessionTtlMs,
  });
}

function clearSessionCookie(res: Response, auth: AuthConfig) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: auth.cookieSecure,
    path: "/api",
  });
}

const invalidInvite = () =>
  new HttpError(404, "invalid_invite", "This invite link is invalid, used or expired");

/**
 * Dashboard login, logout and invite acceptance. Mounted before requireAuth:
 * these are how a browser gets a session in the first place. Every POST
 * still has to come from an allowed Origin (login CSRF would otherwise let a
 * hostile page log the victim into the attacker's account).
 */
export function authApi(db: Db, auth: AuthConfig) {
  const api = express.Router();
  const limiter = new FailureLimiter(LOGIN_FAILURES);
  api.use(express.json({ limit: "10kb" }), requireAllowedOrigin(auth.allowedOrigins));

  const startSession = async (res: Response, userId: string) => {
    const session = await createSession(db, userId, auth.sessionTtlMs);
    setSessionCookie(res, auth, session.token);
  };

  api.post("/login", async (req: Request, res: Response) => {
    const body = parse(loginSchema, req.body);
    const keys = [`ip:${req.ip}`, `email:${body.email}`];
    const wait = Math.max(...keys.map((k) => limiter.retryAfterMs(k)));
    if (wait > 0) {
      res.set("Retry-After", String(Math.ceil(wait / 1000)));
      throw new HttpError(429, "too_many_attempts", "Too many failed logins, try again later");
    }

    const user = await findUserByEmail(db, body.email);
    // Unknown email, no password yet, and disabled all look the same as a
    // wrong password, and all cost one scrypt.
    const ok =
      user?.password_hash && !user.disabled_at
        ? await verifyPassword(body.password, user.password_hash)
        : await burnPasswordCheck(body.password);
    if (!ok || !user) {
      keys.forEach((k) => limiter.recordFailure(k));
      log("warn", "dashboard login failed", { email: body.email, ip: req.ip });
      throw new HttpError(401, "invalid_credentials", "Invalid email or password");
    }
    limiter.reset(`email:${body.email}`);
    await startSession(res, user.id);
    log("info", "dashboard login", { email: user.email });
    res.json(userView(user));
  });

  /** Idempotent: always clears the cookie, deletes the session if there is one. */
  api.post("/logout", async (req: Request, res: Response) => {
    const token = readCookie(req, SESSION_COOKIE) ?? "";
    if (looksLikeToken(token)) {
      const principal = await findPrincipalBySessionHash(db, hashToken(token));
      if (principal?.sessionId) await deleteSession(db, principal.sessionId);
    }
    clearSessionCookie(res, auth);
    res.status(204).end();
  });

  /** Who the invite is for, so the page can say "Set a password for a@b.c". */
  api.get("/invites/:token", async (req: Request, res: Response) => {
    const token = String(req.params.token);
    const invite = looksLikeToken(token) ? await findValidInvite(db, hashToken(token)) : undefined;
    if (!invite) throw invalidInvite();
    res.json({
      email: invite.user.email,
      name: invite.user.name,
      // An invite for someone who already has a password is a reset.
      isReset: invite.user.password_hash !== null,
    });
  });

  api.post("/invites/:token/accept", async (req: Request, res: Response) => {
    const token = String(req.params.token);
    const body = parse(acceptSchema, req.body);
    const invite = looksLikeToken(token) ? await findValidInvite(db, hashToken(token)) : undefined;
    if (!invite) throw invalidInvite();
    const accepted = await acceptInvite(
      db,
      invite.inviteId,
      invite.user.id,
      await hashPassword(body.password),
    );
    if (!accepted) throw invalidInvite(); // used by a concurrent request
    await startSession(res, invite.user.id);
    log("info", "invite accepted", { email: invite.user.email });
    res.json(userView(invite.user));
  });

  return api;
}
