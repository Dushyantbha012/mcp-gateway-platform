import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { insertServer } from "./servers.js";
import {
  createStore,
  deleteStoreRow,
  listStores,
  pendingStores,
  SlugTakenError,
  storeCounts,
  StoreLimitError,
  transitionStore,
} from "./stores.js";
import { createUser } from "./users.js";

describe.skipIf(!hasTestDb)("stores", () => {
  let t: TestDatabase;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    alice = (await createUser(t.db, { email: "alice@x.io", name: "Alice", role: "member" })).id;
    bob = (await createUser(t.db, { email: "bob@x.io", name: "Bob", role: "member" })).id;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("creates a store, and a retried request returns the same one", async () => {
    const first = await createStore(t.db, { slug: "acme", name: "Acme", owner_id: alice }, 2);
    expect(first.created).toBe(true);
    expect(first.store).toMatchObject({ status: "provisioning", kind: "provisioned" });
    const again = await createStore(t.db, { slug: "acme", name: "Acme", owner_id: alice }, 2);
    expect(again).toEqual({ store: first.store, created: false });
  });

  it("refuses a slug another user holds, or that an MCP server already uses", async () => {
    await expect(
      createStore(t.db, { slug: "acme", name: "Acme", owner_id: bob }, 2),
    ).rejects.toBeInstanceOf(SlugTakenError);
    await insertServer(t.db, { slug: "github", name: "GitHub", url: "https://x.io/mcp" });
    await expect(
      createStore(t.db, { slug: "github", name: "GitHub", owner_id: bob }, 2),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("enforces the per-user limit even under concurrent requests", async () => {
    const results = await Promise.allSettled(
      ["b1", "b2", "b3", "b4"].map((slug) =>
        createStore(t.db, { slug, name: slug, owner_id: bob }, 2),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.every((r) => r.reason instanceof StoreLimitError)).toBe(true);
  });

  it("lists stores with their owner's email", async () => {
    const stores = await listStores(t.db);
    expect(stores.find((s) => s.slug === "acme")?.owner_email).toBe("alice@x.io");
  });

  it("only transitions from the expected statuses", async () => {
    const [acme] = (await listStores(t.db)).filter((s) => s.slug === "acme");
    expect(await transitionStore(t.db, acme.id, ["ready"], { status: "deleting" })).toBeUndefined();
    const deleting = await transitionStore(t.db, acme.id, ["provisioning", "ready", "failed"], {
      status: "deleting",
    });
    expect(deleting?.status).toBe("deleting");
  });

  it("hands the provisioner only provisioned stores with work left", async () => {
    await t.db
      .insertInto("stores")
      .values({ slug: "default", name: "Default", kind: "default", status: "ready" })
      .execute();
    const pending = await pendingStores(t.db, 10);
    expect(pending).toHaveLength(3); // acme + whichever two of bob's won the race
    expect(pending.map((s) => s.slug)).toContain("acme");
    expect(pending.every((s) => s.kind === "provisioned")).toBe(true);
    expect(await storeCounts(t.db)).toMatchObject({ provisioning: 2, deleting: 1, ready: 1 });
  });

  it("allows only one default store", async () => {
    await expect(
      t.db
        .insertInto("stores")
        .values({ slug: "other", name: "Other", kind: "default", status: "ready" })
        .execute(),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects slugs that can't be a tool prefix or namespace", async () => {
    await expect(
      t.db.insertInto("stores").values({ slug: "Bad_Slug", name: "x" }).execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("notifies stores_changed on every write", async () => {
    const listener = new pg.Client({ connectionString: t.url });
    await listener.connect();
    try {
      const got = new Promise<string>((resolve) =>
        listener.on("notification", (n) => resolve(n.payload ?? "")),
      );
      await listener.query("listen stores_changed");
      const { store } = await createStore(t.db, { slug: "zeta", name: "Zeta", owner_id: alice }, 5);
      expect(await got).toBe(store.id);
    } finally {
      await listener.end();
    }
  });

  it("deletes the row", async () => {
    const zeta = (await listStores(t.db)).find((s) => s.slug === "zeta")!;
    await deleteStoreRow(t.db, zeta.id);
    const left = await sql<{
      n: string;
    }>`select count(*) as n from stores where slug = 'zeta'`.execute(t.db);
    expect(Number(left.rows[0].n)).toBe(0);
  });
});
