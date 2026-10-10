import express from "express";
import { z } from "zod";
import { principalOf, requireAdmin, requireSession } from "../auth/middleware.js";
import type { AuthConfig } from "../config.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "../crypto/passwords.js";
import {
  getApiKey,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyInfo,
} from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import { createInvite } from "../db/invites.js";
import type { User } from "../db/schema.js";
import { deleteUserSessions } from "../db/sessions.js";
import {
  createUser,
  getUser,
  LastAdminError,
  listUsers,
  setPasswordHash,
  updateUser,
} from "../db/users.js";
import { conflictOnDuplicate, HttpError, notFound, parse } from "./errors.js";

/** Never includes the password hash - only whether one is set. */
export const userView = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.created_at,
  disabledAt: u.disabled_at,
  hasPassword: u.password_hash !== null,
});

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

const keyView = (k: ApiKeyInfo) => ({
  id: k.id,
  userId: k.user_id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at,
  revokedAt: k.revoked_at,
});

const createUserSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "member"]).default("member"),
});

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(["admin", "member"]),
    disabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to change");

const changePasswordSchema = z.object({
  currentPassword: z.string().max(MAX_PASSWORD_LENGTH),
  newPassword: passwordSchema,
});

const createKeySchema = z.object({ name: z.string().trim().min(1).max(100) });

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** Users and their API keys. Admins manage everyone; members only themselves. */
export function usersApi(db: Db, auth: AuthConfig) {
  const api = express.Router();

  /**
   * A one-time link to set a password. There's no mail server, so the admin
   * copies it to the person; the token is shown only in this response.
   */
  const issueInvite = async (userId: string, createdBy: string) => {
    const invite = await createInvite(db, { userId, createdBy, ttlMs: auth.inviteTtlMs });
    return {
      inviteUrl: `${auth.dashboardUrl ?? ""}/invite/${invite.token}`,
      inviteExpiresAt: invite.expiresAt,
    };
  };

  /** A user id the caller may act on: their own, or any if admin. */
  const userParam = async (id: string, res: express.Response) => {
    const principal = principalOf(res);
    const userId = id === "me" ? principal.userId : id;
    if (principal.role !== "admin" && userId !== principal.userId) {
      throw new HttpError(403, "forbidden", "You can only manage your own keys");
    }
    const user = isUuid(userId) ? await getUser(db, userId) : undefined;
    if (!user) throw notFound("User");
    return user;
  };

  api.get("/me", async (_req, res) => {
    const user = await getUser(db, principalOf(res).userId);
    res.json(userView(user!));
  });

  api.get("/users", requireAdmin, async (_req, res) => {
    res.json((await listUsers(db)).map(userView));
  });

  /** Self-service password change; ends the user's other sessions. */
  api.post("/me/password", requireSession, async (req, res) => {
    const principal = principalOf(res);
    const body = parse(changePasswordSchema, req.body);
    const user = await getUser(db, principal.userId);
    const ok = user?.password_hash
      ? await verifyPassword(body.currentPassword, user.password_hash)
      : false;
    if (!ok) throw new HttpError(400, "invalid_credentials", "Current password is incorrect");
    await setPasswordHash(db, principal.userId, await hashPassword(body.newPassword));
    await deleteUserSessions(db, principal.userId, { except: principal.sessionId! });
    res.status(204).end();
  });

  // "Invite": creates the account and returns the link the person uses to
  // set their password. They can then log in and generate their own keys.
  api.post("/users", requireAdmin, async (req, res) => {
    const body = parse(createUserSchema, req.body);
    const user = await createUser(db, body).catch(conflictOnDuplicate(`User ${body.email}`));
    res
      .status(201)
      .json({ ...userView(user), ...(await issueInvite(user.id, principalOf(res).userId)) });
  });

  api.patch("/users/:id", requireAdmin, async (req, res) => {
    const principal = principalOf(res);
    const id = String(req.params.id);
    const body = parse(updateUserSchema, req.body);
    if (id === principal.userId && (body.disabled === true || body.role === "member")) {
      throw new HttpError(409, "conflict", "You can't disable or demote yourself");
    }
    const user = isUuid(id)
      ? await updateUser(db, id, body).catch((err) => {
          if (err instanceof LastAdminError) throw new HttpError(409, "conflict", err.message);
          throw err;
        })
      : undefined;
    if (!user) throw notFound("User");
    res.json(userView(user));
  });

  /** A fresh invite link: for someone who lost theirs, or as an admin password reset. */
  api.post("/users/:id/invite", requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    const user = isUuid(id) ? await getUser(db, id) : undefined;
    if (!user) throw notFound("User");
    if (user.disabled_at) throw new HttpError(409, "conflict", "User is disabled");
    res.status(201).json(await issueInvite(user.id, principalOf(res).userId));
  });

  api.get("/users/:id/keys", async (req, res) => {
    const user = await userParam(req.params.id, res);
    res.json((await listApiKeys(db, user.id)).map(keyView));
  });

  /** The only time the plaintext key is ever returned. */
  api.post("/users/:id/keys", async (req, res) => {
    const user = await userParam(req.params.id, res);
    const body = parse(createKeySchema, req.body);
    const generated = generateApiKey();
    const info = await insertApiKey(db, { userId: user.id, name: body.name, ...generated });
    res.status(201).json({ ...keyView(info), key: generated.key });
  });

  api.delete("/keys/:id", async (req, res) => {
    const principal = principalOf(res);
    const key = isUuid(req.params.id) ? await getApiKey(db, req.params.id) : undefined;
    // Someone else's key looks the same as a missing one to a member.
    if (!key || (principal.role !== "admin" && key.user_id !== principal.userId)) {
      throw notFound("API key");
    }
    res.json(keyView((await revokeApiKey(db, key.id))!));
  });

  return api;
}
