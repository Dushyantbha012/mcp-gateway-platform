import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque bearer tokens for browser sessions and invite links: 32 random
 * bytes, base64url. Like API keys they're stored only as SHA-256 - 256
 * random bits need no slow hash, and a deterministic one allows an indexed
 * lookup.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface NewToken {
  token: string;
  hash: Buffer;
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function looksLikeToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function generateToken(): NewToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
