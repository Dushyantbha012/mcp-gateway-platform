import { randomUUID } from "node:crypto";
import { hashApiKey, prefixOf } from "./crypto/apiKeys.js";
import { hashPassword } from "./crypto/passwords.js";
import type { CredentialStore } from "./credentials/store.js";
import type { Config } from "./config.js";
import type { Db } from "./db/db.js";
import { getServerBySlug, insertServer } from "./db/servers.js";
import { createUser, findUserByEmail, setPasswordHash } from "./db/users.js";
import { log } from "./logger.js";

/**
 * Runs on every startup and only ever adds what's missing, so a restart
 * never undoes an admin's changes: a disabled or edited WooCommerce server
 * stays that way, and a revoked bootstrap key stays revoked.
 */
export async function seed(db: Db, credentials: CredentialStore, config: Config): Promise<void> {
  if (config.bootstrapAdmin) await seedAdmin(db, config.bootstrapAdmin);
  if (config.seedWoocommerce) await seedWoocommerce(db, credentials, config.seedWoocommerce);
}

async function seedAdmin(db: Db, admin: { email: string; apiKey: string; password?: string }) {
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

  // Dashboard password: only if the admin has none, so a password changed in
  // the dashboard survives restarts. (Concurrent replicas may both set it -
  // to the same password, which is harmless.)
  if (admin.password && user.password_hash === null) {
    await setPasswordHash(db, user.id, await hashPassword(admin.password));
    log("info", "seeded bootstrap admin password", { email: user.email });
  }
}

async function seedWoocommerce(
  db: Db,
  credentials: CredentialStore,
  wc: { url: string; token: string; storeUrl?: string },
) {
  if (await getServerBySlug(db, "woocommerce")) return seedDefaultStore(db, wc);
  const id = randomUUID();
  await credentials.put(id, wc.token);
  await insertServer(db, {
    id,
    slug: "woocommerce",
    name: "WooCommerce",
    url: wc.url,
    auth_type: "bearer",
    has_credential: true,
  })
    // Another replica seeded it at the same moment: fine.
    .catch(async (err: { code?: string }) => {
      await credentials.delete(id).catch(() => undefined);
      if (err.code !== "23505") throw err;
    });
  log("info", "seeded upstream server", { slug: "woocommerce" });
  await seedDefaultStore(db, wc);
}

/**
 * The Helm-installed store, listed on the Stores page next to provisioned
 * ones. It is `kind: default`: the provisioner never touches it and it can't
 * be deleted from the dashboard (it belongs to the Helm release).
 */
async function seedDefaultStore(db: Db, wc: { url: string; storeUrl?: string }) {
  const server = await getServerBySlug(db, "woocommerce");
  if (!server) return;
  // In-cluster MCP URLs look like http://<svc>.<namespace>.svc.cluster.local:3000/mcp.
  const host = new URL(wc.url).hostname.split(".");
  const namespace = host.length >= 3 && host[2] === "svc" ? host[1] : null;
  const inserted = await db
    .insertInto("stores")
    .values({
      slug: server.slug,
      name: "Default store",
      kind: "default",
      status: "ready",
      namespace,
      url: wc.storeUrl ?? null,
      server_id: server.id,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) log("info", "seeded default store", { slug: server.slug });
}
