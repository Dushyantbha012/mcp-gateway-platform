import express from "express";
import { z } from "zod";
import { HttpError, notFound, parse } from "../api/errors.js";
import { writeAudit } from "../audit/writer.js";
import { principalOf, requireSession } from "../auth/middleware.js";
import type { OAuthConfig } from "../config.js";
import { SCOPES, type Scope } from "../crypto/oauth.js";
import type { Db } from "../db/db.js";
import {
  getRequest,
  issueCode,
  listConnectedApps,
  revokeUserGrant,
  takeRequest,
} from "../db/oauth.js";
import { currentRequestId } from "../requestContext.js";
import { redirectWith } from "./server.js";

const decisionSchema = z.object({
  approve: z.boolean(),
  /** What the user ticked; must be within what the client asked for. Default: all of it. */
  scopes: z.array(z.enum(SCOPES)).optional(),
});

/**
 * The dashboard's consent page and "Connected apps" list, behind a session (not an API key or OAuth
 * token: only the person at the browser can approve a client) and the
 * Origin check. Mounted at /api/oauth.
 */
export function oauthConsentApi(db: Db, cfg: OAuthConfig) {
  const api = express.Router();
  api.use(requireSession);

  const load = async (id: string) => {
    const req = z.uuid().safeParse(id).success ? await getRequest(db, id) : undefined;
    if (!req) throw notFound("Authorization request (it may have expired)");
    return req;
  };

  api.get("/requests/:id", async (req, res) => {
    const r = await load(req.params.id);
    res.json({
      id: r.id,
      clientId: r.client_id,
      clientName: r.client_name,
      redirectUri: r.redirect_uri,
      redirectHost: new URL(r.redirect_uri).host,
      scopes: r.scope,
      resource: r.resource,
      expiresAt: r.expires_at,
    });
  });

  /** Approve or deny; returns where to send the browser next (back to the client). */
  api.post("/requests/:id", async (req, res) => {
    const body = parse(decisionSchema, req.body);
    const r = await load(req.params.id);
    const who = principalOf(res);
    const asked = r.scope as Scope[];
    let scopes = body.scopes ?? asked;
    if (body.approve) {
      if (scopes.some((s) => !asked.includes(s))) {
        throw new HttpError(
          400,
          "invalid_request",
          "Can't grant a scope the client didn't ask for",
        );
      }
      if (scopes.includes("mcp:write") && !scopes.includes("mcp:read")) {
        scopes = ["mcp:read", ...scopes];
      }
      if (scopes.length === 0) {
        throw new HttpError(400, "invalid_request", "Choose at least one scope, or deny");
      }
    }
    // Single use: a double-click (or a second tab) can't mint two codes.
    if (!(await takeRequest(db, r.id))) throw notFound("Authorization request");

    let redirectUrl: string;
    if (body.approve) {
      const code = await issueCode(
        db,
        {
          clientId: r.client_id,
          userId: who.userId,
          redirectUri: r.redirect_uri,
          state: r.state,
          codeChallenge: r.code_challenge,
          scope: SCOPES.filter((s) => scopes.includes(s)),
          resource: r.resource,
        },
        cfg.codeTtlMs,
      );
      redirectUrl = redirectWith(cfg, r.redirect_uri, { code, state: r.state });
    } else {
      redirectUrl = redirectWith(cfg, r.redirect_uri, {
        error: "access_denied",
        error_description: "The user denied access",
        state: r.state,
      });
    }
    await writeAudit(db, {
      principal: who,
      source: "dashboard",
      serverSlug: null,
      toolName: body.approve ? "oauth.approve" : "oauth.deny",
      durationMs: 0,
      outcome: body.approve ? "success" : "denied",
      detail: body.approve ? `${r.client_name} (${scopes.join(" ")})` : r.client_name,
      requestId: currentRequestId(),
    });
    res.json({ redirectUrl });
  });

  /** The apps the user has approved that can still get tokens (one row per grant). */
  api.get("/apps", async (_req, res) => {
    const apps = await listConnectedApps(db, principalOf(res).userId);
    res.json(
      apps.map((a) => ({
        id: a.familyId,
        clientId: a.clientId,
        clientName: a.clientName,
        scopes: a.scope,
        createdAt: a.createdAt,
        lastUsedAt: a.lastUsedAt,
      })),
    );
  });

  /** Ends a grant: its access token stops working on the next request, its refresh token too. */
  api.delete("/apps/:id", async (req, res) => {
    const who = principalOf(res);
    const id = req.params.id;
    const apps = z.uuid().safeParse(id).success ? await listConnectedApps(db, who.userId) : [];
    const app = apps.find((a) => a.familyId === id);
    if (!app || !(await revokeUserGrant(db, who.userId, id))) throw notFound("Connected app");
    await writeAudit(db, {
      principal: who,
      source: "dashboard",
      serverSlug: null,
      toolName: "oauth.revoke",
      durationMs: 0,
      outcome: "success",
      detail: app.clientName,
      requestId: currentRequestId(),
    });
    res.status(204).end();
  });

  return api;
}
