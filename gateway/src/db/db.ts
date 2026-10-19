import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import pg from "pg";
import * as m001 from "./migrations/001_initial.js";
import * as m002 from "./migrations/002_dashboard_auth.js";
import * as m003 from "./migrations/003_tool_permissions.js";
import * as m004 from "./migrations/004_credential_flag.js";
import * as m005 from "./migrations/005_drop_credential_ciphertext.js";
import * as m006 from "./migrations/006_audit_request_id.js";
import * as m007 from "./migrations/007_audit_detail.js";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;

// Migrations are listed in code rather than read from a folder, so the
// compiled image needs no extra files and the order is explicit.
const migrations: Record<string, Migration> = {
  "001_initial": m001,
  "002_dashboard_auth": m002,
  "003_tool_permissions": m003,
  "004_credential_flag": m004,
  "005_drop_credential_ciphertext": m005,
  "006_audit_request_id": m006,
  "007_audit_detail": m007,
};

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Waits for Postgres to accept connections. On a fresh install the gateway
 * pod usually starts before Postgres is ready (its headless Service has no
 * DNS record until then); waiting here avoids a crash-restart loop with
 * growing back-off.
 */
export async function waitForDatabase(
  db: Db,
  opts: { attempts: number; delayMs: number; onRetry?: (error: string) => void },
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`select 1`.execute(db);
      return;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (attempt >= opts.attempts) throw new Error(`Database unavailable: ${error}`);
      opts.onRetry?.(error);
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
  }
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
