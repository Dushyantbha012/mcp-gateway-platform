import { randomUUID } from "node:crypto";
import { hashApiKey, prefixOf } from "./crypto/apiKeys.js";
import type { SecretBox } from "./crypto/secretBox.js";
import type { Config } from "./config.js";
import type { Db } from "./db/db.js";
import { getServerBySlug, insertServer } from "./db/servers.js";
import { createUser, findUserByEmail } from "./db/users.js";
import { log } from "./logger.js";

/**
 * Runs on every startup and only ever adds what's missing, so a restart
 * never undoes an admin's changes: a disabled or edited WooCommerce server
 * stays that way, and a revoked bootstrap key stays revoked.
 */
export async function seed(db: Db, box: SecretBox, config: Config): Promise<void> {
  if (config.bootstrapAdmin) await seedAdmin(db, config.bootstrapAdmin);
  if (config.seedWoocommerce) await seedWoocommerce(db, box, config.seedWoocommerce);
}

async function seedAdmin(db: Db, admin: { email: string; apiKey: string }) {
  let user = await findUserByEmail(db, admin.email);
  if (!user) {
    try {
      user = await createUser(db, { email: admin.email, name: "Admin", role: "admin" });
      log("info", "seeded bootstrap admin", { email: user.email });
    } catch (err) {
      // Another replica created it between our read and insert.
      if ((err as { code?: string }).code !== "23505") throw err;
      user = (await findUserByEmail(db, admin.email))!;
    }
  }
  // Inserted once; ON CONFLICT keeps an existing row (even a revoked one) untouched.
  const inserted = await db
    .insertInto("api_keys")
    .values({
      user_id: user.id,
      name: "bootstrap",
      prefix: prefixOf(admin.apiKey),
      key_hash: hashApiKey(admin.apiKey),
    })
    .onConflict((oc) => oc.column("key_hash").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) log("info", "seeded bootstrap admin key", { prefix: prefixOf(admin.apiKey) });
}

async function seedWoocommerce(db: Db, box: SecretBox, wc: { url: string; token: string }) {
  if (await getServerBySlug(db, "woocommerce")) return;
  const id = randomUUID();
  await insertServer(db, {
    id,
    slug: "woocommerce",
    name: "WooCommerce",
    url: wc.url,
    auth_type: "bearer",
    credential_ciphertext: box.encrypt(wc.token, id),
  })
    // Another replica seeded it at the same moment: fine.
    .catch((err: { code?: string }) => {
      if (err.code !== "23505") throw err;
    });
  log("info", "seeded upstream server", { slug: "woocommerce" });
}
