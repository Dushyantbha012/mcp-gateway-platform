import express from "express";
import { z } from "zod";
import { writeAudit } from "../audit/writer.js";
import { principalOf } from "../auth/middleware.js";
import type { Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import type { Store } from "../db/schema.js";
import {
  createStore,
  getStoreWithOwner,
  listStores,
  SlugTakenError,
  StoreLimitError,
  transitionStore,
  type StoreWithOwner,
} from "../db/stores.js";
import { currentRequestId } from "../requestContext.js";
import { SLUG_PATTERN } from "../upstreams/naming.js";
import { HttpError, notFound, parse } from "./errors.js";

export interface StoresConfig {
  /** Off = the list still shows the default store, but nothing can be created. */
  enabled: boolean;
  maxPerUser: number;
  timeoutSeconds: number;
}

/** "Acme Inc." -> "acme-inc": the store's tool prefix and namespace suffix. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 31)
    .replace(/-+$/, "");
  return slug;
}

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .regex(SLUG_PATTERN, "must be 2-31 chars: lowercase letters, digits, dashes")
      .optional(),
  })
  .strict();

const canManage = (store: Pick<Store, "owner_id">, who: Principal) =>
  who.role === "admin" || store.owner_id === who.userId;

export function storeView(store: StoreWithOwner, who: Principal) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    kind: store.kind,
    status: store.status,
    step: store.step,
    reason: store.reason,
    url: store.url,
    namespace: store.namespace,
    serverId: store.server_id,
    owner: store.owner_id ? { id: store.owner_id, email: store.owner_email } : null,
    canManage: store.kind === "provisioned" && canManage(store, who),
    createdAt: store.created_at,
    updatedAt: store.updated_at,
  };
}

/**
 * Stores: everyone sees every store (the whole team uses their tools), any
 * user may create up to `maxPerUser`, and only the owner or an admin may
 * delete or retry one. The API only records intent; the provisioner does the
 * work and reports back on the same row.
 */
export function storesApi(db: Db, config: StoresConfig) {
  const api = express.Router();

  const load = async (id: unknown) => {
    const parsed = z.uuid().safeParse(id);
    const store = parsed.success ? await getStoreWithOwner(db, parsed.data) : undefined;
    if (!store) throw notFound("Store");
    return store;
  };
  const audit = (
    who: Principal,
    action: string,
    store: { slug: string; name: string },
    outcome: "success" | "rejected" | "denied" = "success",
    error?: string,
  ) =>
    writeAudit(db, {
      principal: who,
      source: "dashboard",
      serverSlug: store.slug,
      toolName: `stores.${action}`,
      durationMs: 0,
      outcome,
      error,
      detail: store.name,
      requestId: currentRequestId(),
    });
  const manageable = async (id: unknown, who: Principal, action: string) => {
    const store = await load(id);
    if (store.kind === "default") {
      throw new HttpError(
        409,
        "default_store",
        "The default store belongs to the Helm release and can't be changed here",
      );
    }
    if (!canManage(store, who)) {
      await audit(who, action, store, "denied", "not the owner");
      throw new HttpError(403, "forbidden", "Only the store's owner or an admin can do that");
    }
    return store;
  };
  const deadline = () => new Date(Date.now() + config.timeoutSeconds * 1000);

  api.get("/", async (_req, res) => {
    const who = principalOf(res);
    res.json({
      enabled: config.enabled,
      maxPerUser: config.maxPerUser,
      stores: (await listStores(db)).map((s) => storeView(s, who)),
    });
  });

  api.get("/:id", async (req, res) => {
    res.json(storeView(await load(req.params.id), principalOf(res)));
  });

  api.post("/", async (req, res) => {
    const who = principalOf(res);
    if (!config.enabled) {
      throw new HttpError(
        503,
        "stores_disabled",
        "Store provisioning is not enabled on this gateway",
      );
    }
    const body = parse(createSchema, req.body);
    const slug = body.slug ?? slugify(body.name);
    if (!SLUG_PATTERN.test(slug)) {
      throw new HttpError(
        400,
        "invalid_request",
        "name must contain at least two letters or digits, starting with a letter (or pass a slug)",
      );
    }
    try {
      const { store, created } = await createStore(
        db,
        { slug, name: body.name, owner_id: who.userId, deadline_at: deadline() },
        config.maxPerUser,
      );
      if (created) await audit(who, "create", store);
      // Same owner either way: the caller.
      res.status(created ? 201 : 200).json(storeView({ ...store, owner_email: who.email }, who));
    } catch (err) {
      if (err instanceof StoreLimitError) {
        await audit(who, "create", { slug, name: body.name }, "rejected", err.message);
        throw new HttpError(409, "store_limit", err.message);
      }
      if (err instanceof SlugTakenError) throw new HttpError(409, "conflict", err.message);
      throw err;
    }
  });

  api.delete("/:id", async (req, res) => {
    const who = principalOf(res);
    const store = await manageable(req.params.id, who, "delete");
    if (store.status === "deleting") return res.status(202).json(storeView(store, who));
    const deleting = await transitionStore(db, store.id, ["provisioning", "ready", "failed"], {
      status: "deleting",
      step: "deleting",
      reason: null,
    });
    if (!deleting) throw new HttpError(409, "conflict", "The store changed meanwhile; try again");
    await audit(who, "delete", store);
    res.status(202).json(storeView({ ...deleting, owner_email: store.owner_email }, who));
  });

  api.post("/:id/retry", async (req, res) => {
    const who = principalOf(res);
    const store = await manageable(req.params.id, who, "retry");
    if (store.status !== "failed") {
      throw new HttpError(409, "conflict", "Only a failed store can be retried");
    }
    // step "retry" tells the provisioner to clear the failed bootstrap Job first.
    const retried = await transitionStore(db, store.id, ["failed"], {
      status: "provisioning",
      step: "retry",
      reason: null,
      deadline_at: deadline(),
    });
    if (!retried) throw new HttpError(409, "conflict", "The store changed meanwhile; try again");
    await audit(who, "retry", store);
    res.json(storeView({ ...retried, owner_email: store.owner_email }, who));
  });

  return api;
}
