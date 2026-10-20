import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "../crypto/apiKeys.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { insertApiKey, findPrincipalByKeyHash, revokeApiKey, touchApiKey } from "./apiKeys.js";
import { auditStats, insertAuditEntry, queryAudit } from "./audit.js";
import { createDb, migrate, waitForDatabase } from "./db.js";
import {
  insertServer,
  recordServerHealth,
  getServer,
  updateServer,
  deleteServer,
} from "./servers.js";
import { createUser } from "./users.js";

describe("waitForDatabase", () => {
  it("retries, then fails with a clear error when Postgres never comes up", async () => {
    const db = createDb("postgres://u:p@127.0.0.1:9/none", 1);
    const retries: string[] = [];
    await expect(
      waitForDatabase(db, { attempts: 3, delayMs: 10, onRetry: (e) => retries.push(e) }),
    ).rejects.toThrow(/Database unavailable/);
    expect(retries).toHaveLength(2);
    await db.destroy();
  });
});

describe.skipIf(!hasTestDb)("migrations", () => {
  const created: TestDatabase[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((t) => t.drop()));
  });

  it("apply cleanly to an empty database and are a no-op the second time", async () => {
    const t = await createTestDatabase({ migrated: false });
    created.push(t);
    expect(await migrate(t.db)).toEqual([
      "001_initial",
      "002_dashboard_auth",
      "003_tool_permissions",
      "004_credential_flag",
      "005_drop_credential_ciphertext",
      "006_audit_request_id",
      "007_audit_detail",
      "008_write_approvals",
    ]);
    expect(await migrate(t.db)).toEqual([]);
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name not like 'kysely_%' order by table_name`.execute(
      t.db,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "api_keys",
      "audit_log",
      "invites",
      "mcp_servers",
      "sessions",
      "tool_permissions",
      "users",
      "write_approvals",
    ]);
  });

  it("run exactly once when several replicas migrate at the same time", async () => {
    const t = await createTestDatabase({ migrated: false });
    created.push(t);
    const replicas = [t.db, createDb(t.url, 2), createDb(t.url, 2)];
    const results = await Promise.all(replicas.map((db) => migrate(db)));
    await Promise.all(replicas.slice(1).map((db) => db.destroy()));
    expect(results.flat().sort()).toEqual([
      "001_initial",
      "002_dashboard_auth",
      "003_tool_permissions",
      "004_credential_flag",
      "005_drop_credential_ciphertext",
      "006_audit_request_id",
      "007_audit_detail",
      "008_write_approvals",
    ]);
  });
});

describe.skipIf(!hasTestDb)("schema constraints and repositories", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const server = (slug: string) => ({ slug, name: slug, url: "http://example.test/mcp" });

  it.each(["Bad", "has_underscore", "a", "1abc", "x".repeat(32)])(
    "rejects server slug %j",
    async (slug) => {
      await expect(insertServer(t.db, server(slug))).rejects.toThrow(/check constraint/);
    },
  );

  it("rejects duplicate slugs, non-http URLs and credentials missing for auth", async () => {
    await insertServer(t.db, server("dup"));
    await expect(insertServer(t.db, server("dup"))).rejects.toThrow(/unique/);
    await expect(
      insertServer(t.db, { ...server("ftp"), url: "ftp://example.test" }),
    ).rejects.toThrow(/check constraint/);
    await expect(insertServer(t.db, { ...server("noauth"), auth_type: "bearer" })).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      insertServer(t.db, {
        ...server("noheader"),
        auth_type: "header",
        has_credential: true,
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects bad roles and duplicate emails (case-insensitive)", async () => {
    await createUser(t.db, { email: "Dup@Example.com", name: "A", role: "member" });
    await expect(
      createUser(t.db, { email: "dup@example.com", name: "B", role: "member" }),
    ).rejects.toThrow(/unique/);
    await expect(
      // @ts-expect-error - invalid role on purpose
      createUser(t.db, { email: "r@example.com", name: "R", role: "owner" }),
    ).rejects.toThrow(/check constraint/);
  });

  it("resolves a key to its user, and stops resolving it once revoked", async () => {
    const user = await createUser(t.db, { email: "k@example.com", name: "K", role: "member" });
    const k = generateApiKey();
    const info = await insertApiKey(t.db, { userId: user.id, name: "laptop", ...k });
    expect(info).not.toHaveProperty("key_hash");

    expect(await findPrincipalByKeyHash(t.db, k.hash)).toEqual({
      userId: user.id,
      email: "k@example.com",
      role: "member",
      authMethod: "api_key",
      keyId: info.id,
      sessionId: null,
    });

    await touchApiKey(t.db, info.id);
    const revoked = await revokeApiKey(t.db, info.id);
    expect(revoked?.last_used_at).toBeInstanceOf(Date);
    expect(revoked?.revoked_at).toBeInstanceOf(Date);
    expect(await findPrincipalByKeyHash(t.db, k.hash)).toBeUndefined();

    const again = await revokeApiKey(t.db, info.id);
    expect(again?.revoked_at).toEqual(revoked?.revoked_at);
  });

  it("stops resolving keys of a disabled user, and rejects duplicate hashes", async () => {
    const user = await createUser(t.db, { email: "d@example.com", name: "D", role: "admin" });
    const k = generateApiKey();
    await insertApiKey(t.db, { userId: user.id, name: "a", ...k });
    await expect(insertApiKey(t.db, { userId: user.id, name: "b", ...k })).rejects.toThrow(
      /unique/,
    );
    await t.db
      .updateTable("users")
      .set({ disabled_at: new Date() })
      .where("id", "=", user.id)
      .execute();
    expect(await findPrincipalByKeyHash(t.db, k.hash)).toBeUndefined();
  });

  it("records health without touching updated_at, and keeps the tool cache on failure", async () => {
    const s = await insertServer(t.db, server("health"));
    await recordServerHealth(t.db, s.id, { status: "connected", tools: [{ name: "x" }] });
    let row = await getServer(t.db, s.id);
    expect(row?.status).toBe("connected");
    expect(row?.tools_cache).toEqual([{ name: "x" }]);
    expect(row?.updated_at).toEqual(s.updated_at);

    await recordServerHealth(t.db, s.id, { status: "unreachable", error: "ECONNREFUSED" });
    row = await getServer(t.db, s.id);
    expect(row?.status).toBe("unreachable");
    expect(row?.last_error).toBe("ECONNREFUSED");
    expect(row?.tools_cache).toEqual([{ name: "x" }]);

    const edited = await updateServer(t.db, s.id, { name: "Renamed" });
    expect(edited!.updated_at.getTime()).toBeGreaterThanOrEqual(s.updated_at.getTime());
    expect(await deleteServer(t.db, s.id)).toBe(true);
    expect(await deleteServer(t.db, s.id)).toBe(false);
  });

  it("keeps audit rows after the user is deleted, and filters/paginates newest first", async () => {
    const user = await createUser(t.db, { email: "a@example.com", name: "A", role: "member" });
    for (const tool of ["one", "two", "three"]) {
      await insertAuditEntry(t.db, {
        user_id: user.id,
        user_email: user.email,
        api_key_id: null,
        source: "mcp",
        server_slug: tool === "two" ? "github" : "woocommerce",
        tool_name: tool,
        duration_ms: 5,
        outcome: "success",
        error: null,
      });
    }
    await t.db.deleteFrom("users").where("id", "=", user.id).execute();

    const all = await queryAudit(t.db, {});
    const mine = all.filter((e) => e.user_email === "a@example.com");
    expect(mine.map((e) => e.tool_name)).toEqual(["three", "two", "one"]);
    expect(mine.every((e) => e.user_id === null)).toBe(true);

    const github = await queryAudit(t.db, { serverSlug: "github" });
    expect(github.map((e) => e.tool_name)).toEqual(["two"]);

    const page = await queryAudit(t.db, { beforeId: mine[0].id, limit: 1 });
    expect(page.map((e) => e.tool_name)).toEqual(["two"]);
  });
  it("aggregates audit stats: totals, error rate inputs, series and top tools", async () => {
    const base = {
      user_id: null,
      user_email: "stats@example.com",
      api_key_id: null,
      source: "mcp" as const,
      error: null,
    };
    const rows = [
      { server_slug: "stats-a", tool_name: "alpha", duration_ms: 10, outcome: "success" as const },
      { server_slug: "stats-a", tool_name: "alpha", duration_ms: 30, outcome: "success" as const },
      { server_slug: "stats-b", tool_name: "beta", duration_ms: 50, outcome: "timeout" as const },
      { server_slug: "stats-b", tool_name: "beta", duration_ms: 20, outcome: "denied" as const },
    ];
    for (const r of rows) await insertAuditEntry(t.db, { ...base, ...r });

    const now = Date.now();
    const stats = await auditStats(t.db, {
      since: new Date(now - 3_600_000),
      previousSince: new Date(now - 2 * 3_600_000),
      bucket: "hour",
    });
    const mineTools = stats.topTools.filter((x) => x.server?.startsWith("stats-"));
    expect(mineTools.find((x) => x.tool === "alpha")?.count).toBe(2);
    // denied is policy working as intended, so only the timeout counts as an error
    expect(stats.totals.errors).toBeGreaterThanOrEqual(1);
    expect(stats.byOutcome.find((o) => o.outcome === "timeout")?.count).toBeGreaterThanOrEqual(1);
    expect(stats.series.reduce((n, p) => n + p.success + p.errors, 0)).toBeGreaterThanOrEqual(3);
    expect(stats.previous.total).toBe(0);
  });
});
