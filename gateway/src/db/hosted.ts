import { sql } from "kysely";
import type { Db } from "./db.js";
import type { HostedServer, HostedServerUpdate, HostedStatus, NewHostedServer } from "./schema.js";
import { SlugTakenError, slugInUse, lockSlugs } from "./stores.js";

export { SlugTakenError };

/** A hosted server with its creator's email, as the API lists it. */
export type HostedWithCreator = HostedServer & { created_by_email: string | null };

const withCreator = (db: Db) =>
  db
    .selectFrom("hosted_servers")
    .leftJoin("users", "users.id", "hosted_servers.created_by")
    .selectAll("hosted_servers")
    .select("users.email as created_by_email");

export function listHosted(db: Db): Promise<HostedWithCreator[]> {
  return withCreator(db).orderBy("hosted_servers.created_at").execute();
}

export function getHostedWithCreator(db: Db, id: string): Promise<HostedWithCreator | undefined> {
  return withCreator(db).where("hosted_servers.id", "=", id).executeTakeFirst();
}

export function getHosted(db: Db, id: string): Promise<HostedServer | undefined> {
  return db.selectFrom("hosted_servers").selectAll().where("id", "=", id).executeTakeFirst();
}

/**
 * Inserts a hosted server. Its slug becomes a tool prefix, so it must be free
 * among MCP servers and stores too; the check and insert run under the same
 * lock store creation takes, so the two can't claim one slug at once.
 */
export async function createHosted(db: Db, row: NewHostedServer): Promise<HostedServer> {
  return db.transaction().execute(async (trx) => {
    await lockSlugs(trx);
    if (await slugInUse(trx, row.slug)) throw new SlugTakenError(row.slug);
    return trx.insertInto("hosted_servers").values(row).returningAll().executeTakeFirstOrThrow();
  });
}

/**
 * Changes a hosted server only while it is in one of `from`, so the API and
 * the provisioner never clobber each other's transitions (see transitionStore).
 */
export function transitionHosted(
  db: Db,
  id: string,
  from: HostedStatus[],
  changes: HostedServerUpdate,
): Promise<HostedServer | undefined> {
  return db
    .updateTable("hosted_servers")
    .set({ ...changes, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "in", from)
    .returningAll()
    .executeTakeFirst();
}

export function updateHosted(
  db: Db,
  id: string,
  changes: HostedServerUpdate,
): Promise<HostedServer | undefined> {
  return db
    .updateTable("hosted_servers")
    .set({ ...changes, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

/** Hosted servers the provisioner still has work to do on, oldest first. */
export function pendingHosted(db: Db, limit: number): Promise<HostedServer[]> {
  return db
    .selectFrom("hosted_servers")
    .selectAll()
    .where("status", "in", ["provisioning", "deleting"])
    .orderBy("updated_at")
    .limit(limit)
    .execute();
}

export async function deleteHostedRow(db: Db, id: string): Promise<void> {
  await db.deleteFrom("hosted_servers").where("id", "=", id).execute();
}
