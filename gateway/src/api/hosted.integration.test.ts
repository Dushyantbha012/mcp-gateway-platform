import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MemoryHostedEnvStore } from "../credentials/hostedEnv.js";
import { transitionHosted } from "../db/hosted.js";
import { buildTestApp, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

describe.skipIf(!hasTestDb)("hosted servers API", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let secrets: MemoryHostedEnvStore;
  let admin: Awaited<ReturnType<typeof userWithKey>>;
  let member: Awaited<ReturnType<typeof userWithKey>>;

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db);
    secrets = gw.hostedEnv;
    admin = await userWithKey(t.db, "admin@example.com", "admin");
    member = await userWithKey(t.db, "member@example.com", "member");
  });
  afterEach(async () => {
    await t.db.deleteFrom("hosted_servers").execute();
    await t.db.deleteFrom("stores").execute();
    await t.db.deleteFrom("mcp_servers").execute();
    await t.db.deleteFrom("audit_log").execute();
    secrets.entries.clear();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const as = (who: { key: string }) => ({
    get: (path: string) => request(gw.app).get(path).set("Authorization", `Bearer ${who.key}`),
    post: (path: string, body?: object) =>
      request(gw.app).post(path).set("Authorization", `Bearer ${who.key}`).send(body),
    patch: (path: string, body: object) =>
      request(gw.app).patch(path).set("Authorization", `Bearer ${who.key}`).send(body),
    delete: (path: string) =>
      request(gw.app).delete(path).set("Authorization", `Bearer ${who.key}`),
  });

  const thinking = {
    slug: "thinking",
    name: "Sequential thinking",
    image: "mcp/sequentialthinking:0.6.2",
    transport: "stdio",
    command: ["node", "dist/index.js"],
    libc: "musl",
  };

  it("creates a stdio server with defaults, queued for the provisioner", async () => {
    const res = await as(admin).post("/api/hosted", thinking);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      slug: "thinking",
      transport: "stdio",
      command: ["node", "dist/index.js"],
      port: 8080,
      path: "/mcp",
      libc: "musl",
      env: {},
      secretEnvKeys: [],
      egress: "none",
      size: "small",
      status: "provisioning",
      step: "queued",
      createdBy: { email: "admin@example.com" },
    });
    const row = await t.db.selectFrom("hosted_servers").selectAll().executeTakeFirstOrThrow();
    const minutes = (row.deadline_at!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);

    const list = (await as(admin).get("/api/hosted")).body;
    expect(list).toMatchObject({ enabled: true, imageAllowlist: expect.any(Array) });
    expect(list.servers.map((s: { slug: string }) => s.slug)).toEqual(["thinking"]);
    const audit = await t.db.selectFrom("audit_log").selectAll().execute();
    expect(audit).toMatchObject([
      {
        tool_name: "hosted.create",
        server_slug: "thinking",
        source: "dashboard",
        outcome: "success",
      },
    ]);
  });

  it("is admin-only", async () => {
    expect((await as(member).get("/api/hosted")).status).toBe(403);
    expect((await as(member).post("/api/hosted", thinking)).status).toBe(403);
    expect(await t.db.selectFrom("hosted_servers").selectAll().execute()).toHaveLength(0);
  });

  it("refuses images outside the allowlist, :latest and unpinned images, and audits it", async () => {
    for (const [image, message] of [
      ["evil/miner:1", /not in the image allowlist/],
      ["ghcr.io/acme/server-evil:1", /not in the image allowlist/],
      ["mcp/time:latest", /latest/],
      ["mcp/time", /pin the image/],
    ] as const) {
      const res = await as(admin).post("/api/hosted", { ...thinking, image });
      expect(res.status, image).toBe(400);
      expect(res.body.error.code).toBe("image_not_allowed");
      expect(res.body.error.message).toMatch(message);
    }
    expect(await t.db.selectFrom("hosted_servers").selectAll().execute()).toHaveLength(0);
    const refused = await t.db
      .selectFrom("audit_log")
      .selectAll()
      .where("tool_name", "=", "hosted.image_refused")
      .execute();
    expect(refused).toHaveLength(4);
    expect(refused[0]).toMatchObject({ outcome: "rejected", detail: "evil/miner:1" });
  });

  it("validates the spec as a whole", async () => {
    const bad = async (body: object, message: RegExp) => {
      const res = await as(admin).post("/api/hosted", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.message).toMatch(message);
    };
    await bad({ ...thinking, command: [] }, /command is required for a stdio server/);
    await bad({ ...thinking, env: { BRIDGE_AUTH_TOKEN: "x" } }, /reserved for the bridge/);
    await bad({ ...thinking, env: { "BAD-NAME": "x" } }, /valid environment variable name/);
    await bad(
      { ...thinking, env: { TOKEN: "a" }, secretEnv: { TOKEN: "b" } },
      /both a plain and a secret/,
    );
    await bad({ ...thinking, authTokenEnv: "MCP_AUTH_TOKEN" }, /authTokenEnv is for http/);
    await bad(
      { ...thinking, transport: "http", authTokenEnv: "TOKEN", env: { TOKEN: "x" } },
      /set by the provisioner/,
    );
    await bad({ ...thinking, transport: "sse" }, /transport/);
    await bad({ ...thinking, path: "mcp" }, /path/);
    await bad({ ...thinking, privileged: true }, /privileged/);
  });

  it("keeps secret env values out of Postgres and the API", async () => {
    const res = await as(admin).post("/api/hosted", {
      slug: "everything",
      name: "Everything",
      image: "mcp/everything:2025.9.25",
      transport: "http",
      command: ["node", "dist/index.js", "streamableHttp"],
      port: 3001,
      env: { LOG_LEVEL: "debug" },
      secretEnv: { UPSTREAM_API_KEY: "s3cret-value-123" },
      egress: "internet",
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      env: { LOG_LEVEL: "debug" },
      secretEnvKeys: ["UPSTREAM_API_KEY"],
      egress: "internet",
      port: 3001,
    });
    expect(await secrets.get(res.body.id)).toEqual({ UPSTREAM_API_KEY: "s3cret-value-123" });

    const dump = JSON.stringify(await t.db.selectFrom("hosted_servers").selectAll().execute());
    expect(dump).not.toContain("s3cret-value-123");
    for (const path of ["/api/hosted", `/api/hosted/${res.body.id}`]) {
      expect((await as(admin).get(path)).text).not.toContain("s3cret-value-123");
    }
  });

  it("shares one slug space with stores and URL servers", async () => {
    expect((await as(admin).post("/api/stores", { name: "Acme" })).status).toBe(201);
    const clash = await as(admin).post("/api/hosted", { ...thinking, slug: "acme" });
    expect(clash.status).toBe(409);

    expect((await as(admin).post("/api/hosted", thinking)).status).toBe(201);
    const store = await as(admin).post("/api/stores", { name: "Thinking" });
    expect(store.status).toBe(409);
    const byUrl = await as(admin).post("/api/servers", {
      slug: "thinking",
      name: "Thinking",
      url: "https://example.com/mcp",
    });
    expect(byUrl.status).toBe(409);
    expect(byUrl.body.error.message).toMatch(/store or hosted server/);
    expect((await as(admin).post("/api/hosted", thinking)).status).toBe(409);
  });

  it("drops the Secret again when the row can't be created", async () => {
    await as(admin).post("/api/hosted", thinking);
    const res = await as(admin).post("/api/hosted", { ...thinking, secretEnv: { KEY: "v" } });
    expect(res.status).toBe(409);
    expect(secrets.entries.size).toBe(0);
  });

  it("updates: merges secret values, re-queues on spec changes, not on a rename", async () => {
    const created = (
      await as(admin).post("/api/hosted", { ...thinking, secretEnv: { A: "1", B: "2" } })
    ).body;
    await transitionHosted(t.db, created.id, ["provisioning"], { status: "ready", step: "ready" });

    const renamed = await as(admin).patch(`/api/hosted/${created.id}`, { name: "Thinker" });
    expect(renamed.status, renamed.text).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Thinker", status: "ready" });

    const changed = await as(admin).patch(`/api/hosted/${created.id}`, {
      secretEnv: { A: null, C: "3" },
      size: "medium",
    });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body).toMatchObject({
      status: "provisioning",
      step: "updating",
      size: "medium",
      secretEnvKeys: ["B", "C"],
    });
    expect(await secrets.get(created.id)).toEqual({ B: "2", C: "3" });

    const cleared = await as(admin).patch(`/api/hosted/${created.id}`, {
      secretEnv: { B: null, C: null },
    });
    expect(cleared.body.secretEnvKeys).toEqual([]);
    expect(secrets.entries.has(created.id)).toBe(false);

    expect(
      (await as(admin).patch(`/api/hosted/${created.id}`, { image: "mcp/time:latest" })).status,
    ).toBe(400);
    expect((await as(admin).patch(`/api/hosted/${created.id}`, { command: [] })).status).toBe(400);
    expect((await as(admin).patch(`/api/hosted/${created.id}`, { slug: "other" })).status).toBe(
      400,
    );
  });

  it("deletes via the provisioner, and retries only failed servers", async () => {
    const created = (await as(admin).post("/api/hosted", thinking)).body;
    expect((await as(admin).post(`/api/hosted/${created.id}/retry`)).status).toBe(409);

    await transitionHosted(t.db, created.id, ["provisioning"], {
      status: "failed",
      reason: "ImagePullBackOff",
    });
    const retried = await as(admin).post(`/api/hosted/${created.id}/retry`);
    expect(retried.body).toMatchObject({ status: "provisioning", step: "retry", reason: null });

    const del = await as(admin).delete(`/api/hosted/${created.id}`);
    expect(del.status).toBe(202);
    expect(del.body).toMatchObject({ status: "deleting" });
    // Repeating it is harmless; changing a deleting server isn't allowed.
    expect((await as(admin).delete(`/api/hosted/${created.id}`)).status).toBe(202);
    expect((await as(admin).patch(`/api/hosted/${created.id}`, { size: "medium" })).status).toBe(
      409,
    );
    expect((await as(admin).get(`/api/hosted/not-a-uuid`)).status).toBe(404);
  });

  it("answers 503 to changes when hosting is switched off", async () => {
    const off = buildTestApp(
      t.db,
      {},
      {
        hosted: { enabled: false, imageAllowlist: [], timeoutSeconds: 600 },
      },
    );
    const res = await request(off.app)
      .post("/api/hosted")
      .set("Authorization", `Bearer ${admin.key}`)
      .send(thinking);
    expect(res.status).toBe(503);
    const list = await request(off.app)
      .get("/api/hosted")
      .set("Authorization", `Bearer ${admin.key}`);
    expect(list.body).toMatchObject({ enabled: false, servers: [] });
  });
});
