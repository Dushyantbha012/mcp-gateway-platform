import { describe, expect, it } from "vitest";
import { decide, isAllowed, type PermissionRule, type Subject } from "./evaluate.js";

const member: Subject = { userId: "u-b", role: "member" };
const otherMember: Subject = { userId: "u-c", role: "member" };
const admin: Subject = { userId: "u-a", role: "admin" };
const update = { serverSlug: "woocommerce", toolName: "update_order_status" };
const list = { serverSlug: "woocommerce", toolName: "list_orders" };

const role = (effect: "allow" | "deny", toolName: string | null, r = "member"): PermissionRule => ({
  subjectType: "role",
  subject: r,
  serverSlug: "woocommerce",
  toolName,
  effect,
});
const user = (
  effect: "allow" | "deny",
  toolName: string | null,
  id = "u-b",
  serverSlug = "woocommerce",
): PermissionRule => ({ subjectType: "user", subject: id, serverSlug, toolName, effect });

describe("decide", () => {
  it("allows by default when no rule matches", () => {
    expect(decide(member, update, [])).toEqual({ allowed: true, reason: "default" });
  });

  it("denies a tool the member's role is denied", () => {
    const d = decide(member, update, [role("deny", "update_order_status")]);
    expect(d.allowed).toBe(false);
  });

  it("leaves other tools of the same server alone", () => {
    expect(isAllowed(member, list, [role("deny", "update_order_status")])).toBe(true);
  });

  it("a server-wide deny covers every tool, including ones not seen yet", () => {
    const rules = [role("deny", null)];
    expect(isAllowed(member, update, rules)).toBe(false);
    expect(isAllowed(member, { serverSlug: "woocommerce", toolName: "brand_new" }, rules)).toBe(
      false,
    );
  });

  it("a rule for another server does not apply", () => {
    expect(isAllowed(member, update, [user("deny", null, "u-b", "github")])).toBe(true);
  });

  it("admins are never restricted, even by a rule naming them", () => {
    const rules = [role("deny", null, "admin"), user("deny", null, "u-a")];
    expect(decide(admin, update, rules)).toEqual({ allowed: true, reason: "admin" });
  });

  it("a rule for another role or another user does not apply", () => {
    expect(isAllowed(member, update, [role("deny", null, "viewer")])).toBe(true);
    expect(isAllowed(member, update, [user("deny", null, "u-c")])).toBe(true);
  });

  describe("precedence", () => {
    it("tool rule beats server rule for the same subject", () => {
      expect(isAllowed(member, list, [role("deny", null), role("allow", "list_orders")])).toBe(
        true,
      );
      expect(
        isAllowed(member, update, [role("allow", null), role("deny", "update_order_status")]),
      ).toBe(false);
    });

    it("user rule beats role rule: allow one person despite a role deny", () => {
      const rules = [role("deny", "update_order_status"), user("allow", "update_order_status")];
      expect(isAllowed(member, update, rules)).toBe(true);
      expect(isAllowed(otherMember, update, rules)).toBe(false);
    });

    it("user rule beats role rule: deny one person despite a role allow", () => {
      const rules = [role("allow", null), user("deny", "update_order_status")];
      expect(isAllowed(member, update, rules)).toBe(false);
      expect(isAllowed(otherMember, update, rules)).toBe(true);
    });

    it("subject outranks specificity: a user server rule beats a role tool rule", () => {
      const rules = [role("deny", "update_order_status"), user("allow", null)];
      expect(isAllowed(member, update, rules)).toBe(true);
    });

    it("deny beats allow when equally specific", () => {
      const rules = [role("allow", "update_order_status"), role("deny", "update_order_status")];
      expect(isAllowed(member, update, rules)).toBe(false);
      expect(isAllowed(member, update, [...rules].reverse())).toBe(false);
      const server = [role("allow", null), role("deny", null)];
      expect(isAllowed(member, update, server)).toBe(false);
    });

    it("rule order does not matter", () => {
      const rules = [
        role("deny", null),
        role("allow", "list_orders"),
        user("deny", "list_orders"),
        user("allow", "list_orders"),
      ];
      const forward = isAllowed(member, list, rules);
      expect(isAllowed(member, list, [...rules].reverse())).toBe(forward);
      expect(forward).toBe(false);
    });
  });

  it("reports the rule that decided", () => {
    const rule = role("deny", "update_order_status");
    const d = decide(member, update, [role("allow", null), rule]);
    expect(d).toEqual({ allowed: false, reason: "rule", rule });
  });
});
