import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { generateApiKey, hashApiKey } from "./crypto/apiKeys.js";
import { createSecretBox } from "./crypto/secretBox.js";
import { findPrincipalByKeyHash, revokeApiKey } from "./db/apiKeys.js";
import { getServerBySlug, listServers, updateServer } from "./db/servers.js";
import { listUsers } from "./db/users.js";
import { seed } from "./seed.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "./test/testDb.js";

describe.skipIf(!hasTestDb)("startup seeding", () => {
  const box = createSecretBox(randomBytes(32).toString("base64"));
  const adminKey = generateApiKey().key;
  const config = {
    bootstrapAdmin: { email: "Admin@Example.com", apiKey: adminKey },
    seedWoocommerce: { url: "http://woo.urumi.svc.cluster.local:3000/mcp", token: "wc-token" },
  } as Config;
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("creates the admin, their key and the WooCommerce server", async () => {
    await seed(t.db, box, config);
    const principal = await findPrincipalByKeyHash(t.db, hashApiKey(adminKey));
    expect(principal).toMatchObject({ email: "admin@example.com", role: "admin" });

    const woo = await getServerBySlug(t.db, "woocommerce");
    expect(woo).toMatchObject({ name: "WooCommerce", auth_type: "bearer", enabled: true });
    expect(box.decrypt(woo!.credential_ciphertext!, woo!.id)).toBe("wc-token");
  });

  it("is idempotent, also when replicas seed concurrently", async () => {
    await Promise.all([seed(t.db, box, config), seed(t.db, box, config), seed(t.db, box, config)]);
    expect(await listUsers(t.db)).toHaveLength(1);
    expect(await listServers(t.db)).toHaveLength(1);
    const keys = await t.db.selectFrom("api_keys").selectAll().execute();
    expect(keys).toHaveLength(1);
  });

  it("never undoes an admin's changes on restart", async () => {
    const woo = await getServerBySlug(t.db, "woocommerce");
    await updateServer(t.db, woo!.id, { enabled: false, name: "Shop" });
    const [key] = await t.db.selectFrom("api_keys").select("id").execute();
    await revokeApiKey(t.db, key.id);

    await seed(t.db, box, config);

    expect(await getServerBySlug(t.db, "woocommerce")).toMatchObject({
      enabled: false,
      name: "Shop",
    });
    expect(await findPrincipalByKeyHash(t.db, hashApiKey(adminKey))).toBeUndefined();
  });

  it("survives replicas seeding an empty database at the same moment", async () => {
    const fresh = await createTestDatabase();
    try {
      await Promise.all(Array.from({ length: 5 }, () => seed(fresh.db, box, config)));
      expect(await listUsers(fresh.db)).toHaveLength(1);
      expect(await listServers(fresh.db)).toHaveLength(1);
    } finally {
      await fresh.drop();
    }
  });

  it("does nothing when seeding isn't configured", async () => {
    const fresh = await createTestDatabase();
    try {
      await seed(fresh.db, box, {} as Config);
      expect(await listUsers(fresh.db)).toHaveLength(0);
      expect(await listServers(fresh.db)).toHaveLength(0);
    } finally {
      await fresh.drop();
    }
  });
});
