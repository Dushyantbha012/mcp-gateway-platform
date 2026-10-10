import { Kysely, PostgresDialect } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import pg from "pg";
import * as m001 from "./migrations/001_initial.js";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;

// Migrations are listed in code rather than read from a folder, so the
// compiled image needs no extra files and the order is explicit.
const migrations: Record<string, Migration> = {
  "001_initial": m001,
};

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Brings the schema up to date. Kysely's Postgres migrator holds a
 * `pg_advisory_lock` while it runs, so several gateway replicas starting at
 * once apply each migration exactly once.
 */
export async function migrate(db: Db): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((r) => r.status === "Error")?.migrationName;
    throw new Error(
      `Database migration failed${failed ? ` at ${failed}` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
