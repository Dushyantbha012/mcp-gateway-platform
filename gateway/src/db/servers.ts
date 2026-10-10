import { sql } from "kysely";
import type { Db } from "./db.js";
import type { McpServer, McpServerUpdate, NewMcpServer, ServerStatus } from "./schema.js";

export function listServers(db: Db): Promise<McpServer[]> {
  return db.selectFrom("mcp_servers").selectAll().orderBy("created_at").execute();
}

export function getServer(db: Db, id: string): Promise<McpServer | undefined> {
  return db.selectFrom("mcp_servers").selectAll().where("id", "=", id).executeTakeFirst();
}

export function getServerBySlug(db: Db, slug: string): Promise<McpServer | undefined> {
  return db.selectFrom("mcp_servers").selectAll().where("slug", "=", slug).executeTakeFirst();
}

export function insertServer(db: Db, server: NewMcpServer): Promise<McpServer> {
  return db.insertInto("mcp_servers").values(server).returningAll().executeTakeFirstOrThrow();
}

export function updateServer(
  db: Db,
  id: string,
  changes: McpServerUpdate,
): Promise<McpServer | undefined> {
  return db
    .updateTable("mcp_servers")
    .set({ ...changes, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteServer(db: Db, id: string): Promise<boolean> {
  const result = await db.deleteFrom("mcp_servers").where("id", "=", id).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/**
 * Health-check outcome. Doesn't touch updated_at (that tracks admin edits).
 * On success the tool list cache is replaced; on failure the old cache is
 * kept for diagnosis but isn't served while the server is unreachable.
 */
export async function recordServerHealth(
  db: Db,
  id: string,
  result: { status: ServerStatus; error?: string; tools?: unknown[] },
): Promise<void> {
  await db
    .updateTable("mcp_servers")
    .set({
      status: result.status,
      last_error: result.error ?? null,
      last_checked_at: sql<Date>`now()`,
      ...(result.tools
        ? { tools_cache: JSON.stringify(result.tools), tools_cached_at: sql<Date>`now()` }
        : {}),
    })
    .where("id", "=", id)
    .execute();
}
