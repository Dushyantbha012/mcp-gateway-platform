import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Dashboard passwords, hashed with scrypt from node:crypto (no native
 * dependency to build into the image). Unlike API keys, passwords are
 * human-chosen and low-entropy, so the hash must be slow and salted: scrypt
 * is deliberately expensive in CPU and memory, which makes offline guessing
 * against a leaked hash costly.
 *
 * Stored as `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`, so the cost can be
 * raised later and old hashes still verify with the parameters they were
 * made with.
 */
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }; // ~16MB and a few tens of ms per hash
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer, params: typeof PARAMS): Promise<Buffer> {
  // maxmem must cover 128 * N * r bytes, plus headroom.
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, HASH_BYTES, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);
  const { N, r, p } = PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** False for a wrong password and for anything that isn't a hash we made. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Bounded so a tampered row can't make one login allocate gigabytes.
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  if (N > 2 ** 17 || r > 16 || p > 4) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length !== HASH_BYTES) return false;
  const actual = await derive(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}

// A real hash of a random password: logging in as an unknown email still
// pays one scrypt, so response time doesn't reveal which emails exist.
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummy);
  return false;
}
