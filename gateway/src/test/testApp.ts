import { randomBytes } from "node:crypto";
import { createApp } from "../app.js";
import { generateApiKey } from "../crypto/apiKeys.js";
import { createSecretBox } from "../crypto/secretBox.js";
import { insertApiKey } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import type { Role } from "../db/schema.js";
import { createUser } from "../db/users.js";
import { HealthChecker } from "../upstreams/health.js";
import { UpstreamRegistry } from "../upstreams/registry.js";
import { ToolRouter } from "../upstreams/router.js";

/** The gateway app wired exactly as index.ts does, with short test timeouts. */
export function buildTestApp(db: Db) {
  const box = createSecretBox(randomBytes(32).toString("base64"));
  const registry = new UpstreamRegistry(box, { maxResultBytes: 100_000 });
  const health = new HealthChecker(db, registry, { intervalMs: 60_000, listTimeoutMs: 300 });
  const router = new ToolRouter(db, registry);
  const deps = { db, box, registry, health, router };
  return { ...deps, app: createApp(deps) };
}

/** A user with one API key; returns the plaintext key for requests. */
export async function userWithKey(db: Db, email: string, role: Role) {
  const user = await createUser(db, { email, name: email.split("@")[0], role });
  const generated = generateApiKey();
  const info = await insertApiKey(db, { userId: user.id, name: "test", ...generated });
  return { user, key: generated.key, keyId: info.id };
}
