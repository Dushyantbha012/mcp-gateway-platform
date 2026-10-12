import type { Db } from "../db/db.js";
import { log } from "../logger.js";
import type { CredentialStore } from "./store.js";

/**
 * Deletes credentials whose server no longer exists (e.g. the gateway died
 * between deleting a row and deleting its Secret). Secrets younger than
 * `minAgeMs` are left alone: another replica may be mid-way through creating
 * a server (Secret first, then row).
 */
export async function sweepOrphanedCredentials(
  db: Db,
  store: CredentialStore,
  minAgeMs = 10 * 60_000,
) {
  const [stored, servers] = await Promise.all([
    store.list(),
    db.selectFrom("mcp_servers").select("id").execute(),
  ]);
  const known = new Set(servers.map((s) => s.id));
  let removed = 0;
  for (const { serverId, createdAt } of stored) {
    if (known.has(serverId) || Date.now() - createdAt.getTime() < minAgeMs) continue;
    await store.delete(serverId);
    removed++;
    log("info", "removed orphaned upstream credential", { serverId });
  }
  return removed;
}
