import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTools, FakeLlm, say } from "../chat/fakeLlm.js";
import type { ChatEvent } from "../chat/types.js";
import { queryAudit } from "../db/audit.js";
import { upsertRule } from "../db/permissions.js";
import { insertServer } from "../db/servers.js";
import { startFakeUpstream, type FakeUpstream } from "../test/fakeUpstream.js";
import { buildTestApp, checkUntilConnected, userWithKey } from "../test/testApp.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";

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

describe.skipIf(!hasTestDb)("POST /api/chat in search mode", () => {
  let t: TestDatabase;
  let shop: FakeUpstream;
  let llm: FakeLlm;
  let gw: ReturnType<typeof buildTestApp>;
  let alice: Awaited<ReturnType<typeof userWithKey>>;

  const chat = (key: string, text: string) =>
    request(gw.app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${key}`)
      .buffer(true)
      .parse(asText)
      .send({ messages: [{ role: "user", text }] });

  beforeAll(async () => {
    t = await createTestDatabase();
    shop = await startFakeUpstream({ toolNames: ["list_orders", "echo"] });
    await insertServer(t.db, { slug: "shop", name: "Shop", url: shop.url, timeout_ms: 2_000 });
    gw = buildTestApp(
      t.db,
      {},
      {
        chat: {
          llm: { generate: (req) => llm.generate(req) },
          turnsPerMinute: 1000,
          limits: { turnTimeoutMs: 5_000 },
          searchMode: "on",
        },
      },
    );
    await checkUntilConnected(gw);
    alice = await userWithKey(t.db, "alice@example.com", "member");
  });
  afterAll(async () => {
    await gw?.registry.closeAll();
    await shop?.close();
    await t?.drop();
  });

  it("gives the model just the two meta-tools, and lets it search then call", async () => {
    llm = new FakeLlm([
      callTools({ name: "search_tools", args: { query: "echo" }, id: "s" }),
      (req) => {
        // The search result, as the model sees it, names the real tool.
        const last = req.turns.at(-1);
        const output = last?.role === "tool" ? last.results[0].output : "";
        expect(JSON.parse(output).results[0].name).toBe("shop__echo");
        return callTools({
          name: "call_tool",
          args: { name: "shop__echo", arguments: { value: "hi" } },
          id: "c",
        });
      },
      say("It said hi."),
    ]);

    const res = await chat(alice.key, "echo hi");
    const events = parseSse(res.body as string);

    expect(llm.requests[0].tools.map((tool) => tool.name)).toEqual(["search_tools", "call_tool"]);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "done",
    ]);
    // The browser sees the real tool, not the wrapper.
    expect(events[2]).toMatchObject({ name: "shop__echo", server: "shop" });
    expect(events[3]).toMatchObject({ name: "shop__echo", isError: false, summary: "echo:hi" });

    // The search and the call it led to are both audited, newest first.
    const rows = await queryAudit(t.db, { source: "chat" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tool_name: "shop__echo",
      server_slug: "shop",
      outcome: "success",
      user_id: alice.user.id,
    });
    expect(rows[1]).toMatchObject({
      tool_name: "search_tools",
      server_slug: null,
      outcome: "success",
      user_id: alice.user.id,
    });
  });

  it("does not let the model find or call a tool the user may not use", async () => {
    await upsertRule(t.db, {
      role: "member",
      serverSlug: "shop",
      toolName: "echo",
      effect: "deny",
      createdBy: null,
    });
    await t.db.deleteFrom("audit_log").execute();
    shop.calls = {};
    llm = new FakeLlm([
      callTools({ name: "search_tools", args: { query: "echo" }, id: "s" }),
      callTools({ name: "call_tool", args: { name: "shop__echo", arguments: {} }, id: "c" }),
      say("I'm not allowed."),
    ]);

    const events = parseSse((await chat(alice.key, "echo")).body as string);

    const found = llm.requests[1].turns.at(-1);
    expect(found?.role === "tool" && found.results[0].output).not.toContain("shop__echo");
    expect(events[3]).toMatchObject({ name: "shop__echo", isError: true });
    expect((await queryAudit(t.db, { source: "chat" }))[0]).toMatchObject({
      tool_name: "shop__echo",
      outcome: "denied",
    });
    expect(shop.calls.echo ?? 0).toBe(0);
  });
});
