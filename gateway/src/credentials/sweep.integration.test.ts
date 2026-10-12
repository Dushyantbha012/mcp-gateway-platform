import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertServer } from "../db/servers.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { sweepOrphanedCredentials } from "./sweep.js";
import { MemoryCredentialStore } from "./store.js";

describe.skipIf(!hasTestDb)("orphaned credential sweep", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("sweeps credentials of deleted servers, but not recent ones or ones still in use", async () => {
    const store = new MemoryCredentialStore();
    const live = randomUUID();
    await insertServer(t.db, {
      id: live,
      slug: "live",
      name: "Live",
      url: "https://example.com/l",
    });
    const orphan = randomUUID();
    await store.put(live, "a");
    await store.put(orphan, "b");

    // Too young: another replica may be creating the server right now.
    expect(await sweepOrphanedCredentials(t.db, store)).toBe(0);
    expect(await store.get(orphan)).not.toBeNull();

    expect(await sweepOrphanedCredentials(t.db, store, 0)).toBe(1);
    expect(await store.get(orphan)).toBeNull();
    expect(await store.get(live)).not.toBeNull();
  });
});
