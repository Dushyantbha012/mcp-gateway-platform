import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, migrate, type Db } from "../db/db.js";

/**
 * Real Postgres for integration tests: docker-compose.test.yml locally, a
 * service container in CI. Each test file gets its own throwaway database so
 * files can run in parallel without seeing each other's rows.
 *
 * Unset TEST_DATABASE_URL = these tests are skipped (with a warning), the
 * same way the live tests skip without a cluster. CI and verify-phase3.sh
 * always set it.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

if (!hasTestDb) {
  console.warn(
    "TEST_DATABASE_URL not set - skipping Postgres integration tests. " +
      "Run `docker compose -f docker-compose.test.yml up -d` and set " +
      "TEST_DATABASE_URL=postgres://gateway_test:gateway_test@localhost:5433/gateway_test",
  );
}

export interface TestDatabase {
  url: string;
  db: Db;
  drop(): Promise<void>;
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty database; `migrated: false` leaves the schema unapplied. */
export async function createTestDatabase(opts: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const name = `gw_test_${randomBytes(6).toString("hex")}`;
  await admin((c) => c.query(`create database ${name}`));
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), 5);
  if (opts.migrated ?? true) await migrate(db);
  return {
    url: url.toString(),
    db,
    async drop() {
      await db.destroy();
      await admin((c) => c.query(`drop database if exists ${name} with (force)`));
    },
  };
}
