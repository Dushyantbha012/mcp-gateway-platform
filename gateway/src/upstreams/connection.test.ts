import { afterEach, describe, expect, it } from "vitest";
import { deadUrl, startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { UpstreamConnection, UpstreamError, type UpstreamConfig } from "./connection.js";

const started: FakeUpstream[] = [];
const connections: UpstreamConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
  await Promise.all(started.splice(0).map((f) => f.close()));
});

async function fake(opts: Parameters<typeof startFakeUpstream>[0] = {}) {
  const f = await startFakeUpstream(opts);
  started.push(f);
  return f;
}

function connect(url: string, overrides: Partial<UpstreamConfig> = {}) {
  const conn = new UpstreamConnection(
    { id: "id-1", slug: "fake", url, headers: {}, timeoutMs: 400, ...overrides },
    { maxResultBytes: 10_000 },
  );
  connections.push(conn);
  return conn;
}

async function expectUpstreamError(promise: Promise<unknown>, kind: string, message: RegExp) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UpstreamError);
  expect((err as UpstreamError).kind).toBe(kind);
  expect((err as UpstreamError).message).toMatch(message);
}

describe("UpstreamConnection", () => {
  it("lists tools and sends only the configured credential header", async () => {
    const f = await fake();
    const conn = connect(f.url, { headers: { Authorization: "Bearer upstream-secret" } });
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_products", "echo", "fail", "big"]);
    expect(f.requests.length).toBeGreaterThan(0);
    for (const headers of f.requests) {
      expect(headers.authorization).toBe("Bearer upstream-secret");
    }
  });

  it("sends a custom header credential and no Authorization header when none is configured", async () => {
    const f = await fake();
    await connect(f.url, { headers: { "X-Api-Key": "k-123" } }).listTools();
    expect(f.requests.every((h) => h["x-api-key"] === "k-123")).toBe(true);
    expect(f.requests.some((h) => h.authorization !== undefined)).toBe(false);
  });

  it("calls a tool and passes its result through", async () => {
    const f = await fake();
    const result = await connect(f.url).callTool("echo", { value: "hi" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  it("passes a tool's own error result through unchanged", async () => {
    const f = await fake();
    const result = await connect(f.url).callTool("fail", {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Order 999 not found" }]);
  });

  it("turns an unknown tool / invalid arguments into an isError result", async () => {
    const f = await fake();
    const conn = connect(f.url);
    const unknown = await conn.callTool("nope", {});
    expect(unknown.isError).toBe(true);
    const invalid = await conn.callTool("big", { bytes: "not a number" });
    expect(invalid.isError).toBe(true);
  });

  it("times out a hanging upstream with a clear error instead of hanging", async () => {
    const f = await fake({ behavior: "hang" });
    const startedAt = Date.now();
    await expectUpstreamError(
      connect(f.url).listTools(),
      "timeout",
      /'fake' timed out after 400ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("enforces one deadline across connect + call", async () => {
    const f = await fake();
    const conn = connect(f.url);
    await conn.listTools(); // connected
    f.behavior = "hang";
    const startedAt = Date.now();
    await expectUpstreamError(conn.callTool("echo", {}), "timeout", /timed out/);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("reports connection refused as unreachable", async () => {
    await expectUpstreamError(
      connect(await deadUrl()).listTools(),
      "unreachable",
      /'fake' is unreachable \(ECONNREFUSED\)/,
    );
  });

  it("reports DNS failures and blocked ports with their reason", async () => {
    await expectUpstreamError(
      connect("http://nothing.invalid/mcp").listTools(),
      "unreachable",
      /is unreachable \(ENOTFOUND\)/,
    );
    await expectUpstreamError(
      connect("http://127.0.0.1:1/mcp").listTools(),
      "unreachable",
      /is unreachable \(bad port\)/,
    );
  });

  it("reports a rejected credential clearly", async () => {
    const f = await fake({ behavior: "unauthorized" });
    await expectUpstreamError(
      connect(f.url).listTools(),
      "unreachable",
      /rejected the gateway's credentials \(HTTP 401\)/,
    );
  });

  it("reports an HTTP 500 as unreachable", async () => {
    const f = await fake({ behavior: "http500" });
    await expectUpstreamError(connect(f.url).listTools(), "unreachable", /returned HTTP 500$/);
  });

  it("refuses results larger than the limit", async () => {
    const f = await fake();
    const result = await connect(f.url).callTool("big", { bytes: 20_000 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/over the gateway's 10000-byte limit/);
  });

  it("reuses one session across calls", async () => {
    const f = await fake({ stateful: true });
    const conn = connect(f.url);
    await conn.listTools();
    await conn.callTool("echo", {});
    await conn.callTool("echo", {});
    expect(f.sessionsCreated).toBe(1);
  });

  it("reconnects once when the upstream forgot the session, without running the tool twice", async () => {
    const f = await fake({ stateful: true });
    const conn = connect(f.url);
    await conn.callTool("echo", { value: "1" });
    f.expireSessions();
    const result = await conn.callTool("echo", { value: "2" });
    expect(result.content).toEqual([{ type: "text", text: "echo:2" }]);
    expect(f.calls.echo).toBe(2);
    expect(f.sessionsCreated).toBe(2);
  });

  it("recovers on the next call once the upstream is back", async () => {
    const f = await fake();
    const conn = connect(f.url);
    f.behavior = "http500";
    await expect(conn.listTools()).rejects.toThrow();
    f.behavior = "ok";
    expect(await conn.listTools()).toHaveLength(4);
  });

  it("is isolated: a hanging upstream doesn't delay a healthy one", async () => {
    const slow = await fake({ behavior: "hang" });
    const healthy = await fake();
    const hanging = connect(slow.url, { timeoutMs: 1_000 })
      .listTools()
      .catch(() => "timed out");
    const startedAt = Date.now();
    await connect(healthy.url).callTool("echo", {});
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(await hanging).toBe("timed out");
  });
});
