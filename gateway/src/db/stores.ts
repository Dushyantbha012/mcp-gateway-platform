import { sql } from "kysely";
import type { Db } from "./db.js";
import type { NewStore, Store, StoreStatus, StoreUpdate } from "./schema.js";

/** A store with its owner's email, as the API lists it. */
export type StoreWithOwner = Store & { owner_email: string | null };

const withOwner = (db: Db) =>
  db
    .selectFrom("stores")
    .leftJoin("users", "users.id", "stores.owner_id")
    .selectAll("stores")
    .select("users.email as owner_email");

export function listStores(db: Db): Promise<StoreWithOwner[]> {
  return withOwner(db).orderBy("stores.created_at").execute();
}

export function getStoreWithOwner(db: Db, id: string): Promise<StoreWithOwner | undefined> {
  return withOwner(db).where("stores.id", "=", id).executeTakeFirst();
}

export function getStore(db: Db, id: string): Promise<Store | undefined> {
  return db.selectFrom("stores").selectAll().where("id", "=", id).executeTakeFirst();
}

export function getStoreBySlug(db: Db, slug: string): Promise<Store | undefined> {
  return db.selectFrom("stores").selectAll().where("slug", "=", slug).executeTakeFirst();
}

export class StoreLimitError extends Error {
  constructor(readonly limit: number) {
    super(`You can have at most ${limit} stores`);
  }
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`The name '${slug}' is already in use`);
  }
}

/**
 * Creates a store for `owner`, or returns the one they already asked for
 * under this slug (a retried request is not a second store).
 *
 * The per-user limit is checked while holding a lock on the owner's row, so
 * two concurrent requests can't both see "1 of 2" and both insert. The slug
 * must also be free among MCP servers: it becomes the store's tool prefix.
 */
export async function createStore(
  db: Db,
  store: NewStore & { owner_id: string },
  limit: number,
): Promise<{ store: Store; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("users")
      .select("id")
      .where("id", "=", store.owner_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const existing = await trx
      .selectFrom("stores")
      .selectAll()
      .where("slug", "=", store.slug)
      .executeTakeFirst();
    if (existing) {
      if (existing.owner_id === store.owner_id && existing.status !== "deleting") {
        return { store: existing, created: false };
      }
      throw new SlugTakenError(store.slug);
    }
    const server = await trx
      .selectFrom("mcp_servers")
      .select("id")
      .where("slug", "=", store.slug)
      .executeTakeFirst();
    if (server) throw new SlugTakenError(store.slug);
    const { count } = await trx
      .selectFrom("stores")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("owner_id", "=", store.owner_id)
      .where("kind", "=", "provisioned")
      .executeTakeFirstOrThrow();
    if (Number(count) >= limit) throw new StoreLimitError(limit);
    const created = await trx
      .insertInto("stores")
      .values(store)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { store: created, created: true };
  });
}

export function updateStore(db: Db, id: string, changes: StoreUpdate): Promise<Store | undefined> {
  return db
    .updateTable("stores")
    .set({ ...changes, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Moves a store between statuses only if it is still in one of `from`: the
 * API and the provisioner both write statuses, and neither may clobber a
 * transition the other just made (e.g. a delete arriving mid-provisioning).
 */
export function transitionStore(
  db: Db,
  id: string,
  from: StoreStatus[],
  changes: StoreUpdate,
): Promise<Store | undefined> {
  return db
    .updateTable("stores")
    .set({ ...changes, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "in", from)
    .returningAll()
    .executeTakeFirst();
}

/** Stores the provisioner still has work to do on, oldest first. */
export function pendingStores(db: Db, limit: number): Promise<Store[]> {
  return db
    .selectFrom("stores")
    .selectAll()
    .where("kind", "=", "provisioned")
    .where("status", "in", ["provisioning", "deleting"])
    .orderBy("updated_at")
    .limit(limit)
    .execute();
}

export async function deleteStoreRow(db: Db, id: string): Promise<void> {
  await db.deleteFrom("stores").where("id", "=", id).execute();
}

/** Counts by status, for the provisioner's gauge. */
export async function storeCounts(db: Db): Promise<Record<StoreStatus, number>> {
  const rows = await db
    .selectFrom("stores")
    .select(["status", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("status")
    .execute();
  const counts = { provisioning: 0, ready: 0, failed: 0, deleting: 0 };
  for (const r of rows) counts[r.status] = Number(r.count);
  return counts;
}
