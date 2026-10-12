import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getServerBySlug, insertServer } from "../db/servers.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { createGuardedFetch, policyFrom } from "./ssrf.js";

// Strict policy: only the literal 127.0.0.1 (where the fakes listen) is allowed
// as a private host, standing in for the Helm allowlist.
const strict = policyFrom(["127.0.0.1"]);

describe.skipIf(!hasTestDb)("SSRF guard in the admin API", () => {
  let t: TestDatabase;
  let gw: ReturnType<typeof buildTestApp>;
  let admin: Awaited<ReturnType<typeof userWithKey>>;
  const fakes: FakeUpstream[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    gw = buildTestApp(t.db, {}, { ssrf: policyFrom([]) });
    admin = await userWithKey(t.db, "admin@example.com", "admin");
  });
  afterEach(async () => {
    await gw.registry.closeAll();
    await Promise.all(fakes.splice(0).map((f) => f.close()));
    await t.db.deleteFrom("mcp_servers").execute();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const api = (method: "post" | "patch", path: string, body: object) =>
    request(gw.app)[method](path).set("Authorization", `Bearer ${admin.key}`).send(body);

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/mcp",
    "http://127.0.0.1:5432/",
    "http://platform-gateway-postgres:5432/",
    "http://kubernetes.default.svc/",
    "http://2130706433/",
    "http://[::ffff:169.254.169.254]/",
  ])("refuses to register %s", async (url) => {
    const res = await api("post", "/api/servers", { slug: "evil", name: "Evil", url });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("url_not_allowed");
    expect(await getServerBySlug(t.db, "evil")).toBeUndefined();
  });

  it("refuses to edit a server so that it points at an internal address", async () => {
    const f = await startFakeUpstream();
    fakes.push(f);
    // Registered while allowed (the way the seeded WooCommerce server is).
    const row = await insertServer(t.db, {
      slug: "good",
      name: "Good",
      url: f.url,
      enabled: true,
      auth_type: "none",
      timeout_ms: 1000,
    } as never);
    const res = await api("patch", `/api/servers/${row.id}`, {
      url: "http://169.254.169.254/",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("url_not_allowed");
    expect((await getServerBySlug(t.db, "good"))?.url).toBe(f.url);
  });

  it("does not reject a PATCH that leaves the URL alone", async () => {
    const f = await startFakeUpstream();
    fakes.push(f);
    const row = await insertServer(t.db, {
      slug: "good",
      name: "Good",
      url: f.url,
      enabled: true,
      auth_type: "none",
      timeout_ms: 1000,
    } as never);
    const res = await api("patch", `/api/servers/${row.id}`, { name: "Renamed" });
    expect(res.status).toBe(200);
  });

  it("marks a stored server that violates the policy as unreachable, with the reason", async () => {
    const f = await startFakeUpstream();
    fakes.push(f);
    const row = await insertServer(t.db, {
      slug: "legacy",
      name: "Legacy",
      url: f.url, // 127.0.0.1 is not allowlisted for this app
      enabled: true,
      auth_type: "none",
      timeout_ms: 1000,
    } as never);
    // The registry here was built with the same strict policy, so the connect-time guard fires.
    const checked = await gw.health.check(row);
    expect(checked.status).toBe("unreachable");
    expect(checked.last_error).toMatch(/blocked by SSRF policy/);
    expect(f.requests.length).toBe(0); // nothing ever reached it
  });
});

describe("guarded fetch and redirects", () => {
  let target: Server;
  let redirector: Server;
  let hits = 0;

  beforeAll(async () => {
    target = createServer((_req, res) => {
      hits++;
      res.end("internal secret");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetPort = (target.address() as AddressInfo).port;
    redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` }).end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  });
  afterAll(async () => {
    target.close();
    redirector.close();
  });

  it("returns a redirect instead of following it", async () => {
    const f = createGuardedFetch(strict);
    const port = (redirector.address() as AddressInfo).port;
    const res = await f(`http://127.0.0.1:${port}/`, { redirect: "follow" });
    expect(res.status).toBe(302);
    expect(hits).toBe(0);
  });
});
