import { describe, expect, it } from "vitest";
import { removesLastAdmin } from "./users.js";

const admin = { role: "admin" as const, disabled_at: null };
const disabledAdmin = { role: "admin" as const, disabled_at: new Date() };
const member = { role: "member" as const, disabled_at: null };

describe("removesLastAdmin", () => {
  it.each([
    ["demoting the only admin", admin, { role: "member" as const }, 0, true],
    ["disabling the only admin", admin, { disabled: true }, 0, true],
    ["demoting an admin when another remains", admin, { role: "member" as const }, 1, false],
    ["disabling an admin when another remains", admin, { disabled: true }, 2, false],
    ["renaming the only admin", admin, { name: "New" }, 0, false],
    ["re-enabling a disabled admin", disabledAdmin, { disabled: false }, 0, false],
    ["changing a disabled admin", disabledAdmin, { role: "member" as const }, 0, false],
    ["disabling a member", member, { disabled: true }, 0, false],
    ["promoting a member", member, { role: "admin" as const }, 0, false],
  ])("%s -> %s", (_label, user, changes, others, expected) => {
    expect(removesLastAdmin(user, changes, others)).toBe(expected);
  });
});
