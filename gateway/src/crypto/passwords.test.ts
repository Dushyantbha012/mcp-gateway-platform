import { describe, expect, it } from "vitest";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./passwords.js";
import { generateToken, hashToken, looksLikeToken } from "./tokens.js";

describe("passwords (scrypt)", () => {
  it("round-trips, salts every hash, and never stores the password", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse battery", b)).toBe(true);
  });

  it("rejects a wrong password, including a one-character change", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("treats Unicode-equivalent spellings as the same password (NFKC)", async () => {
    const stored = await hashPassword("café-password-1");
    expect(await verifyPassword("café-password-1", stored)).toBe(true);
  });

  it.each([
    "",
    "plaintext",
    "bcrypt$10$abc",
    "scrypt$16384$8$1$c2FsdA==", // missing hash
    "scrypt$x$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16384$8$1$c2FsdA==$dG9vc2hvcnQ=", // wrong hash length
    `scrypt$${2 ** 24}$8$1$c2FsdA==$${Buffer.alloc(32).toString("base64")}`, // absurd cost
    `scrypt$16384$64$1$c2FsdA==$${Buffer.alloc(32).toString("base64")}`,
  ])("returns false (never throws) for malformed stored value %j", async (stored) => {
    expect(await verifyPassword("whatever-password", stored)).toBe(false);
  });

  it("burnPasswordCheck always fails but still does the work", async () => {
    expect(await burnPasswordCheck("anything at all")).toBe(false);
  });
});

describe("opaque tokens (sessions, invites)", () => {
  it("are unique, well-formed and match their hash", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
    expect(looksLikeToken(a.token)).toBe(true);
    expect(a.hash).toHaveLength(32);
    expect(a.hash.equals(hashToken(a.token))).toBe(true);
  });

  it.each(["", "short", "a".repeat(44), "has space".padEnd(43, "x"), "+/".repeat(21) + "a"])(
    "rejects malformed token %j",
    (value) => {
      expect(looksLikeToken(value)).toBe(false);
    },
  );
});
