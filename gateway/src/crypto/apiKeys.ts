import { createHash, randomBytes } from "node:crypto";

/**
 * Gateway API keys: `mgw_<8 hex prefix>_<43 base64url chars>`.
 *
 * The prefix is stored in clear so a key can be recognised in the UI and the
 * audit log; the whole key is stored only as a SHA-256 hash. A fast hash is
 * right here (unlike for passwords): 256 random bits can't be brute-forced,
 * and a deterministic hash lets every request find its key with one indexed
 * lookup instead of comparing against every bcrypt hash in the table.
 */
const KEY_PATTERN = /^mgw_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

export interface NewApiKey {
  key: string;
  prefix: string;
  hash: Buffer;
}

export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function prefixOf(key: string): string {
  return key.slice(0, "mgw_".length + 8);
}

export function generateApiKey(): NewApiKey {
  const key = `mgw_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: prefixOf(key), hash: hashApiKey(key) };
}
