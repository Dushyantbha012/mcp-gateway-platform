import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { insertAuditEntry } from "./audit.js";
import {
  deleteRule,
  deleteRulesForServer,
  listPermissionRows,
  rulesFor,
  upsertRule,
} from "./permissions.js";
import { createUser } from "./users.js";

describe.skipIf(!hasTestDb)("tool_permissions", () => {
  let t: TestDatabase;
  let b: string;
  let c: string;
  beforeAll(async () => {
    t = await createTestDatabase();
    b = (await createUser(t.db, { email: "b@example.com", name: "B", role: "member" })).id;
    c = (await createUser(t.db, { email: "c@example.com", name: "C", role: "member" })).id;
  });
  afterAll(async () => {
    await t?.drop();
  });

  const base = { serverSlug: "woocommerce", createdBy: null } as const;

  it("setting the same rule again replaces its effect instead of adding a row", async () => {
    await upsertRule(t.db, { ...base, role: "member", toolName: "x", effect: "allow" });
    const again = await upsertRule(t.db, {
      ...base,
      role: "member",
      toolName: "x",
      effect: "deny",
    });
    expect(again.effect).toBe("deny");
    const rows = (await listPermissionRows(t.db)).filter((r) => r.tool_name === "x");
    expect(rows).toHaveLength(1);
  });

  it("treats a server-wide rule and a tool rule as different targets", async () => {
    await upsertRule(t.db, { ...base, role: "member", toolName: null, effect: "deny" });
    await upsertRule(t.db, { ...base, role: "member", toolName: null, effect: "allow" });
    await upsertRule(t.db, { ...base, role: "member", toolName: "y", effect: "deny" });
    const rows = await listPermissionRows(t.db);
    expect(rows.filter((r) => r.tool_name === null && r.role === "member")).toHaveLength(1);
    expect(rows.filter((r) => r.tool_name === "y")).toHaveLength(1);
  });

  it("keeps role rules and user rules apart", async () => {
    await upsertRule(t.db, { ...base, userId: b, toolName: "z", effect: "allow" });
    await upsertRule(t.db, { ...base, userId: c, toolName: "z", effect: "deny" });
    await upsertRule(t.db, { ...base, role: "member", toolName: "z", effect: "deny" });
    expect((await listPermissionRows(t.db)).filter((r) => r.tool_name === "z")).toHaveLength(3);
  });

  it("rulesFor returns only the caller's own and their role's rules", async () => {
    const rules = await rulesFor(t.db, { userId: b, role: "member" });
    const zUsers = rules.filter((r) => r.toolName === "z" && r.subjectType === "user");
    expect(zUsers).toEqual([expect.objectContaining({ subject: b, effect: "allow" })]);
    expect(rules.some((r) => r.subject === c)).toBe(false);
    const admin = await rulesFor(t.db, {
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    });
    expect(admin).toEqual([]);
  });

  it("requires exactly one subject, a valid slug and a valid effect", async () => {
    const insert = (v: Record<string, unknown>) =>
      t.db
        .insertInto("tool_permissions")
        .values({ server_slug: "woocommerce", tool_name: null, effect: "deny", ...v } as never)
        .execute();
    await expect(insert({})).rejects.toThrow(/check constraint/);
    await expect(insert({ role: "member", user_id: b })).rejects.toThrow(/check constraint/);
    await expect(insert({ role: "owner" })).rejects.toThrow(/check constraint/);
    await expect(insert({ role: "member", server_slug: "Bad_Slug" })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert({ role: "member", effect: "maybe" })).rejects.toThrow(/check constraint/);
  });

  it("removes a user's rules when the user is deleted", async () => {
    const tmp = await createUser(t.db, { email: "tmp@example.com", name: "T", role: "member" });
    await upsertRule(t.db, { ...base, userId: tmp.id, toolName: null, effect: "deny" });
    await t.db.deleteFrom("users").where("id", "=", tmp.id).execute();
    expect((await listPermissionRows(t.db)).some((r) => r.user_id === tmp.id)).toBe(false);
  });

  it("deletes one rule by id, and every rule of a server", async () => {
    const r = await upsertRule(t.db, { ...base, role: "member", toolName: "gone", effect: "deny" });
    expect(await deleteRule(t.db, r.id)).toBe(true);
    expect(await deleteRule(t.db, r.id)).toBe(false);
    await upsertRule(t.db, {
      serverSlug: "github",
      createdBy: null,
      role: "member",
      toolName: null,
      effect: "deny",
    });
    await deleteRulesForServer(t.db, "github");
    expect((await listPermissionRows(t.db)).some((x) => x.server_slug === "github")).toBe(false);
    expect((await listPermissionRows(t.db)).some((x) => x.server_slug === "woocommerce")).toBe(
      true,
    );
  });

  it("accepts the 'denied' audit outcome", async () => {
    await insertAuditEntry(t.db, {
      user_id: b,
      user_email: "b@example.com",
      source: "mcp",
      server_slug: "woocommerce",
      tool_name: "woocommerce__update_order_status",
      duration_ms: 1,
      outcome: "denied",
    });
  });
});
