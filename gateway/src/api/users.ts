import express from "express";
import { z } from "zod";
import { principalOf, requireAdmin } from "../auth/middleware.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import {
  getApiKey,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyInfo,
} from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import type { User } from "../db/schema.js";
import { createUser, getUser, listUsers } from "../db/users.js";
import { conflictOnDuplicate, HttpError, notFound, parse } from "./errors.js";

const userView = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.created_at,
  disabledAt: u.disabled_at,
});

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

const createKeySchema = z.object({ name: z.string().trim().min(1).max(100) });

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** Users and their API keys. Admins manage everyone; members only themselves. */
export function usersApi(db: Db) {
  const api = express.Router();

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

  // "Invite": creates the account; the person then gets an API key issued.
  // (Dashboard login for invited users arrives with the dashboard in Phase 4.)
  api.post("/users", requireAdmin, async (req, res) => {
    const body = parse(createUserSchema, req.body);
    const user = await createUser(db, body).catch(conflictOnDuplicate(`User ${body.email}`));
    res.status(201).json(userView(user));
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
