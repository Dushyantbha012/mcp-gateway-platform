import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSecretBox } from "../crypto/secretBox.js";
import { getServer, insertServer, updateServer } from "../db/servers.js";
import { deadUrl, startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { displayStatus, HealthChecker } from "./health.js";
import { UpstreamRegistry } from "./registry.js";
import { PERMISSIVE_POLICY } from "../security/ssrf.js";

describe.skipIf(!hasTestDb)("health checks + registry", () => {
  const box = createSecretBox(randomBytes(32).toString("base64"));
  let t: TestDatabase;
  let registry: UpstreamRegistry;
  let health: HealthChecker;
  const fakes: FakeUpstream[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterEach(async () => {
    await health?.stop();
    await registry?.closeAll();
    await Promise.all(fakes.splice(0).map((f) => f.close()));
    await t.db.deleteFrom("mcp_servers").execute();
  });
  afterAll(async () => {
    await t?.drop();
  });

  function setup(intervalMs = 60_000) {
    registry = new UpstreamRegistry(box, { maxResultBytes: 100_000, ssrf: PERMISSIVE_POLICY });
    health = new HealthChecker(t.db, registry, { intervalMs, listTimeoutMs: 300 });
  }

  async function fake(opts: Parameters<typeof startFakeUpstream>[0] = {}) {
    const f = await startFakeUpstream(opts);
    fakes.push(f);
    return f;
  }

  function addServer(slug: string, url: string, credential?: string) {
    const id = randomUUID();
    return insertServer(t.db, {
      id,
      slug,
      name: slug,
      url,
      timeout_ms: 300,
      ...(credential
        ? { auth_type: "bearer" as const, credential_ciphertext: box.encrypt(credential, id) }
        : {}),
    });
  }

  it("marks healthy servers connected with cached tools, and dead/hanging ones unreachable", async () => {
    setup();
    const healthy = await fake();
    const hanging = await fake({ behavior: "hang" });
    const ok = await addServer("healthy", healthy.url, "s3cret");
    const slow = await addServer("hanging", hanging.url);
    const dead = await addServer("dead", await deadUrl());

    const startedAt = Date.now();
    await health.checkAll();
    expect(Date.now() - startedAt).toBeLessThan(1_500);

    const okRow = await getServer(t.db, ok.id);
    expect(okRow?.status).toBe("connected");
    expect((okRow?.tools_cache as { name: string }[]).map((x) => x.name)).toContain(
      "list_products",
    );
    expect(healthy.requests.every((h) => h.authorization === "Bearer s3cret")).toBe(true);

    const slowRow = await getServer(t.db, slow.id);
    expect(slowRow?.status).toBe("unreachable");
    expect(slowRow?.last_error).toMatch(/timed out after 300ms/);

    const deadRow = await getServer(t.db, dead.id);
    expect(deadRow?.status).toBe("unreachable");
    expect(deadRow?.last_error).toMatch(/ECONNREFUSED/);
  });

  it("flips a server to unreachable when it goes down, and back when it recovers", async () => {
    setup();
    const f = await fake();
    const s = await addServer("flappy", f.url);
    await health.checkAll();
    expect((await getServer(t.db, s.id))?.status).toBe("connected");

    f.behavior = "http500";
    await health.checkAll();
    const down = await getServer(t.db, s.id);
    expect(down?.status).toBe("unreachable");
    expect(down?.tools_cache).not.toBeNull(); // kept for diagnosis, not served

    f.behavior = "ok";
    await health.checkAll();
    expect((await getServer(t.db, s.id))?.status).toBe("connected");
  });

  it("uses a new connection after an admin edits the URL or credential", async () => {
    setup();
    const first = await fake();
    const second = await fake();
    const s = await addServer("moving", first.url, "old");
    const connA = registry.get(s);
    expect(registry.get(s)).toBe(connA);

    const edited = await updateServer(t.db, s.id, {
      url: second.url,
      credential_ciphertext: box.encrypt("new", s.id),
    });
    const connB = registry.get(edited!);
    expect(connB).not.toBe(connA);
    await connB.listTools();
    expect(second.requests.every((h) => h.authorization === "Bearer new")).toBe(true);
  });

  it("doesn't check disabled servers and reports them as disabled", async () => {
    setup();
    const f = await fake();
    const s = await addServer("off", f.url);
    await updateServer(t.db, s.id, { enabled: false });
    await health.checkAll();
    expect(f.requests).toHaveLength(0);
    const row = await getServer(t.db, s.id);
    expect(displayStatus(row!)).toBe("disabled");
  });

  it("runs on an interval in the background", async () => {
    setup(50);
    const f = await fake();
    const s = await addServer("loop", f.url);
    health.start();
    await expect
      .poll(async () => (await getServer(t.db, s.id))?.status, { timeout: 2_000 })
      .toBe("connected");
    f.behavior = "http500";
    await expect
      .poll(async () => (await getServer(t.db, s.id))?.status, { timeout: 2_000 })
      .toBe("unreachable");
  });
});
