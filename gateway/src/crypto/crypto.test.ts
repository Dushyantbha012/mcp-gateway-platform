import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, looksLikeApiKey, prefixOf } from "./apiKeys.js";
import { createSecretBox } from "./secretBox.js";

describe("API keys", () => {
  it("generates well-formed, unique keys with a matching hash and prefix", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(looksLikeApiKey(a.key)).toBe(true);
    expect(a.key).not.toBe(b.key);
    expect(a.prefix).toBe(a.key.slice(0, 12));
    expect(a.prefix).toBe(prefixOf(a.key));
    expect(a.hash.equals(hashApiKey(a.key))).toBe(true);
    expect(a.hash).toHaveLength(32);
  });

  it("hashes differently for a one-character change", () => {
    const { key, hash } = generateApiKey();
    const tampered = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(hashApiKey(tampered).equals(hash)).toBe(false);
  });

  it.each([
    "",
    "Bearer x",
    "mgw_short",
    `mgw_ZZZZZZZZ_${"a".repeat(43)}`,
    `xyz_12345678_${"a".repeat(43)}`,
  ])("rejects malformed key %j", (value) => {
    expect(looksLikeApiKey(value)).toBe(false);
  });
});

describe("secretBox (AES-256-GCM)", () => {
  const key = randomBytes(32).toString("base64");
  const box = createSecretBox(key);

  it("round-trips and uses a fresh IV each time", () => {
    const a = box.encrypt("ghp_secret", "server-1");
    const b = box.encrypt("ghp_secret", "server-1");
    expect(a.equals(b)).toBe(false);
    expect(a.toString("utf8")).not.toContain("ghp_secret");
    expect(box.decrypt(a, "server-1")).toBe("ghp_secret");
  });

  it("detects tampering with the ciphertext", () => {
    const sealed = box.encrypt("token", "server-1");
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => box.decrypt(sealed, "server-1")).toThrow();
  });

  it("refuses a ciphertext moved to another row (associated data mismatch)", () => {
    const sealed = box.encrypt("token", "server-1");
    expect(() => box.decrypt(sealed, "server-2")).toThrow();
  });

  it("fails with the wrong key", () => {
    const sealed = box.encrypt("token", "server-1");
    const other = createSecretBox(randomBytes(32).toString("base64"));
    expect(() => other.decrypt(sealed, "server-1")).toThrow();
  });

  it("rejects keys that aren't 32 bytes and unknown formats", () => {
    expect(() => createSecretBox(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => box.decrypt(Buffer.from([9, 1, 2]), "x")).toThrow(/format/);
  });
});
