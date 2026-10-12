import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, looksLikeApiKey, prefixOf } from "./apiKeys.js";

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
