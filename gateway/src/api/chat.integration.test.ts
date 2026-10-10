import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { revokeApiKey } from "../db/apiKeys.js";
import { queryAudit } from "../db/audit.js";
import { upsertRule } from "../db/permissions.js";
import { insertServer, updateServer } from "../db/servers.js";
import { callTools, FakeLlm, say, type ScriptEntry } from "../chat/fakeLlm.js";
import type { ChatEvent } from "../chat/types.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, TEST_ORIGIN, userWithKey, userWithPassword } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

/** Parses a finished text/event-stream body into its events (comment lines ignored). */
function parseSse(body: string): ChatEvent[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
}

const asText = (res: unknown, cb: (err: Error | null, body: string) => void) => {
  let data = "";
  const r = res as NodeJS.ReadableStream;
  r.setEncoding("utf8");
  r.on("data", (c: string) => (data += c));
  r.on("end", () => cb(null, data));
};

describe.skipIf(!hasTestDb)("POST /api/chat", () => {
  let t: TestDatabase;
  let shop: FakeUpstream;
  let docs: FakeUpstream;
  let llm: FakeLlm;
  let gw: ReturnType<typeof buildTestApp>;
  let alice: Awaited<ReturnType<typeof userWithKey>>;
  let bob: Awaited<ReturnType<typeof userWithKey>>;

  /** A fresh scripted model per test; the app reads it through this wrapper. */
  const script = (entries: ScriptEntry[]) => {
    llm = new FakeLlm(entries);
  };

  const chat = (key: string, messages: unknown) =>
    request(gw.app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${key}`)
      .buffer(true)
      .parse(asText)
      .send({ messages });
  const ask = (text: string) => [{ role: "user", text }];
  const audit = (email: string) =>
    queryAudit(t.db, { source: "chat" }).then((rows) =>
      rows.filter((r) => r.user_email === email).reverse(),
    );

  beforeAll(async () => {
    t = await createTestDatabase();
    shop = await startFakeUpstream({ toolNames: ["list_orders", "echo"] });
    docs = await startFakeUpstream({ toolNames: ["search"] });
    await insertServer(t.db, { slug: "shop", name: "Shop", url: shop.url, timeout_ms: 2_000 });
    await insertServer(t.db, { slug: "docs", name: "Docs", url: docs.url, timeout_ms: 2_000 });
    gw = buildTestApp(
      t.db,
      {},
      {
        chat: {
          llm: { generate: (req) => llm.generate(req) },
          turnsPerMinute: 1000,
          limits: { turnTimeoutMs: 5_000 },
        },
      },
    );
    await gw.health.checkAll();
    alice = await userWithKey(t.db, "alice@example.com", "member");
    bob = await userWithKey(t.db, "bob@example.com", "member");
  });
  afterAll(async () => {
    await gw?.registry.closeAll();
    await shop?.close();
    await docs?.close();
    await t?.drop();
  });
  beforeEach(() => {
    shop.behavior = "ok";
    docs.behavior = "ok";
  });

  it("streams tool_call, tool_result, text, done - and audits the call as the caller", async () => {
    script([callTools({ name: "shop__echo", args: { value: "hi" } }), say("It said hi.")]);
    const res = await chat(alice.key, ask("echo hi"));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toContain("no-cache");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    const events = parseSse(res.body as string);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(events[1]).toMatchObject({ isError: false, summary: "echo:hi" });

    const rows = await audit("alice@example.com");
    expect(rows.at(-1)).toMatchObject({
      source: "chat",
      server_slug: "shop",
      tool_name: "shop__echo",
      outcome: "success",
      user_id: alice.user.id,
      api_key_id: alice.keyId,
    });
    expect(shop.calls.echo).toBeGreaterThan(0);
  });

  it("attributes each user's calls to that user", async () => {
    script([callTools({ name: "shop__list_orders" }), say("a")]);
    await chat(alice.key, ask("x"));
    script([callTools({ name: "docs__search" }), say("b")]);
    await chat(bob.key, ask("y"));

    const a = await audit("alice@example.com");
    const b = await audit("bob@example.com");
    expect(a.at(-1)).toMatchObject({ tool_name: "shop__list_orders", user_id: alice.user.id });
    expect(b.at(-1)).toMatchObject({ tool_name: "docs__search", user_id: bob.user.id });
    expect(b.every((r) => r.user_id === bob.user.id)).toBe(true);
  });

  it("gives the model exactly the tools an MCP client would see", async () => {
    script([say("hi")]);
    await chat(alice.key, ask("x"));
    const names = llm.requests[0].tools.map((tool) => tool.name).sort();
    const listed = (
      await request(gw.app).get("/api/tools").set("Authorization", `Bearer ${alice.key}`)
    ).body as { name: string }[];
    expect(names).toEqual(listed.map((tool) => tool.name).sort());
    expect(names).toContain("shop__list_orders");
    expect(names).toContain("docs__search");
  });

  describe("tool permissions", () => {
    const denyDocs = (userId: string) =>
      upsertRule(t.db, {
        userId,
        serverSlug: "docs",
        toolName: null,
        effect: "deny",
        createdBy: null,
      });
    afterEach(async () => {
      await t.db.deleteFrom("tool_permissions").execute();
    });

    it("the model is never shown tools the user may not use; other users still get them", async () => {
      await denyDocs(bob.user.id);
      const shownTo = async (key: string) => {
        script([say("hi")]);
        await chat(key, ask("x"));
        return llm.requests[0].tools.map((tool) => tool.name);
      };
      const bobSees = await shownTo(bob.key);
      expect(bobSees).toContain("shop__list_orders");
      expect(bobSees).not.toContain("docs__search");
      expect(await shownTo(alice.key)).toContain("docs__search");
    });

    it("a tool denied mid-conversation is refused, audited as denied, and never runs", async () => {
      const before = docs.calls.search ?? 0;
      script([
        // The rule lands after the model was shown the tool, before it calls it.
        async () => {
          await denyDocs(bob.user.id);
          return callTools({ name: "docs__search" });
        },
        say("I wasn't allowed to."),
      ]);
      const events = parseSse((await chat(bob.key, ask("x"))).body as string);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
      expect(docs.calls.search ?? 0).toBe(before);
      const rows = await audit("bob@example.com");
      expect(rows.at(-1)).toMatchObject({
        source: "chat",
        tool_name: "docs__search",
        outcome: "denied",
      });
    });
  });

  it("passes a tool's own error to the model and the browser, audited as tool_error", async () => {
    script([callTools({ name: "shop__fail" }), say("not found")]);
    const events = parseSse((await chat(alice.key, ask("x"))).body as string);
    expect(events[1]).toMatchObject({
      type: "tool_result",
      isError: true,
      summary: "Order 999 not found",
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((await audit("alice@example.com")).at(-1)).toMatchObject({ outcome: "tool_error" });
    expect(llm.requests[1].turns.at(-1)).toMatchObject({
      role: "tool",
      results: [{ isError: true, output: "Order 999 not found" }],
    });
  });

  it("a dead upstream fails only its own call; the healthy one still works in the same turn", async () => {
    docs.behavior = "http500";
    script([
      callTools(
        { name: "docs__search", id: "a" },
        { name: "shop__echo", args: { value: "ok" }, id: "b" },
      ),
      say("one failed, one worked"),
    ]);
    const events = parseSse((await chat(alice.key, ask("x"))).body as string);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ id: "a", isError: true });
    expect(results[1]).toMatchObject({ id: "b", isError: false, summary: "echo:ok" });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const rows = await audit("alice@example.com");
    expect(rows.slice(-2).map((r) => r.outcome)).toEqual(["unreachable", "success"]);
    await gw.health.checkAll(); // let the dashboard-side status settle for later tests
  });

  it("disabling a server mid-conversation removes its tools from the next turn and rejects stale calls", async () => {
    await gw.health.checkAll();
    script([say("first"), callTools({ name: "docs__search" }), say("second")]);
    await chat(alice.key, ask("one"));
    expect(llm.requests[0].tools.map((x) => x.name)).toContain("docs__search");

    const docsRow = (
      await t.db
        .selectFrom("mcp_servers")
        .select("id")
        .where("slug", "=", "docs")
        .executeTakeFirstOrThrow()
    ).id;
    await updateServer(t.db, docsRow, { enabled: false });
    try {
      const events = parseSse(
        (
          await chat(alice.key, [
            ...ask("one"),
            { role: "assistant", text: "first" },
            { role: "user", text: "again" },
          ])
        ).body as string,
      );
      expect(llm.requests[1].tools.map((x) => x.name)).not.toContain("docs__search");
      expect(events[1]).toMatchObject({ type: "tool_result", isError: true });
      expect((events[1] as { summary: string }).summary).toMatch(/disabled/i);
      expect((await audit("alice@example.com")).at(-1)).toMatchObject({
        outcome: "rejected",
        server_slug: "docs",
      });
    } finally {
      await updateServer(t.db, docsRow, { enabled: true });
      await gw.health.checkAll();
    }
  });

  it("reports a model failure as an error event, not an HTTP error", async () => {
    const { LlmError } = await import("../chat/types.js");
    script([new LlmError("auth", "The Gemini API rejected the gateway's API key.")]);
    const res = await chat(alice.key, ask("x"));
    expect(res.status).toBe(200);
    expect(parseSse(res.body as string)).toEqual([
      { type: "error", code: "auth", message: "The Gemini API rejected the gateway's API key." },
    ]);
  });

  describe("access control", () => {
    it("401 without credentials, and for a revoked key on its next call", async () => {
      const noAuth = await request(gw.app)
        .post("/api/chat")
        .send({ messages: ask("x") });
      expect(noAuth.status).toBe(401);

      const carol = await userWithKey(t.db, "carol@example.com", "member");
      script([say("ok")]);
      expect((await chat(carol.key, ask("x"))).status).toBe(200);
      await revokeApiKey(t.db, carol.keyId);
      expect((await chat(carol.key, ask("x"))).status).toBe(401);
    });

    it("with a session cookie, requires the dashboard's Origin", async () => {
      const u = await userWithPassword(t.db, "dave@example.com", "member", "correct-horse-battery");
      const login = await request(gw.app)
        .post("/api/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: u.email, password: u.password });
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];

      const post = (origin?: string) => {
        const r = request(gw.app)
          .post("/api/chat")
          .set("Cookie", cookie)
          .buffer(true)
          .parse(asText);
        if (origin) r.set("Origin", origin);
        return r.send({ messages: ask("x") });
      };
      expect((await post()).status).toBe(403);
      expect((await post("http://evil.test")).status).toBe(403);
      script([say("hello")]);
      const ok = await post(TEST_ORIGIN);
      expect(ok.status).toBe(200);
      expect(parseSse(ok.body as string).at(-1)).toMatchObject({ type: "done" });
    });
  });

  describe("request validation", () => {
    const bad: [string, unknown][] = [
      ["no body", undefined],
      ["empty messages", []],
      ["last message from the assistant", [{ role: "assistant", text: "hi" }]],
      ["unknown role", [{ role: "system", text: "hi" }]],
      ["empty text", [{ role: "user", text: "" }]],
      ["oversized text", [{ role: "user", text: "x".repeat(8_001) }]],
      ["too many messages", Array.from({ length: 41 }, () => ({ role: "user", text: "x" }))],
    ];
    it.each(bad)("400 for %s", async (_name, messages) => {
      script([say("never")]);
      const res = await chat(alice.key, messages);
      expect(res.status).toBe(400);
      expect(llm.requests).toHaveLength(0);
    });
  });

  it("limits how many turns one user can start per minute, per user", async () => {
    const limited = buildTestApp(
      t.db,
      {},
      {
        chat: { llm: { generate: (r) => llm.generate(r) }, turnsPerMinute: 2 },
      },
    );
    const post = (key: string) =>
      request(limited.app)
        .post("/api/chat")
        .set("Authorization", `Bearer ${key}`)
        .buffer(true)
        .parse(asText)
        .send({ messages: ask("x") });
    script([say("1"), say("2"), say("3")]);
    expect((await post(alice.key)).status).toBe(200);
    expect((await post(alice.key)).status).toBe(200);
    const blocked = await post(alice.key);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(llm.requests).toHaveLength(2);
    // Another user is unaffected.
    expect((await post(bob.key)).status).toBe(200);
    await limited.registry.closeAll();
  });

  it("is 503 chat_not_configured when no model is set, and /api/meta says so", async () => {
    const off = buildTestApp(t.db);
    const res = await request(off.app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${alice.key}`)
      .send({ messages: ask("x") });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("chat_not_configured");
    const meta = await request(off.app)
      .get("/api/meta")
      .set("Authorization", `Bearer ${alice.key}`);
    expect(meta.body.chatEnabled).toBe(false);
    const on = await request(gw.app).get("/api/meta").set("Authorization", `Bearer ${alice.key}`);
    expect(on.body.chatEnabled).toBe(true);
    await off.registry.closeAll();
  });

  it("stops the loop and the tool calls when the browser disconnects mid-turn", async () => {
    let sawAbort!: () => void;
    const aborted = new Promise<void>((r) => (sawAbort = r));
    script([
      (req) =>
        new Promise((_, reject) =>
          req.signal?.addEventListener("abort", () => {
            sawAbort();
            reject(new Error("aborted"));
          }),
        ),
    ]);
    const server = gw.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const ctrl = new AbortController();
      const before = shop.calls.echo ?? 0;
      const pending = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.key}` },
        body: JSON.stringify({ messages: ask("x") }),
        signal: ctrl.signal,
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      ctrl.abort();
      await pending;
      await Promise.race([
        aborted,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("model call was not aborted")), 3_000),
        ),
      ]);
      expect(shop.calls.echo ?? 0).toBe(before);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("never puts upstream credentials or the caller's key in the stream", async () => {
    script([callTools({ name: "shop__echo", args: { value: "x" } }), say("done")]);
    const res = await chat(alice.key, ask("x"));
    expect(res.body as string).not.toContain(alice.key);
    expect(JSON.stringify(llm.requests)).not.toContain(alice.key);
  });
});
