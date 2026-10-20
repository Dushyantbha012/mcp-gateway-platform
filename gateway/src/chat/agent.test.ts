import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { resultText, runAgent, systemPrompt, type AgentDeps } from "./agent.js";
import { callTools, FakeLlm, say } from "./fakeLlm.js";
import { LlmError, type ChatEvent, type ChatMessage } from "./types.js";

const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });
const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});
const ask = (text: string): ChatMessage[] => [{ role: "user", text }];

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function setup(script: ConstructorParameters<typeof FakeLlm>[0], over: Partial<AgentDeps> = {}) {
  const llm = new FakeLlm(script);
  const callTool = vi.fn(async () => ok("{}"));
  const listTools = vi.fn(async () => [tool("shop__list_orders"), tool("shop__get_order")]);
  const deps: AgentDeps = { llm, listTools, callTool, ...over };
  return { llm, callTool, listTools, deps };
}

const types = (events: ChatEvent[]) => events.map((e) => e.type);

describe("runAgent", () => {
  it("answers directly when the model needs no tool", async () => {
    const { deps, callTool } = setup([say("Hello!")]);
    const events = await collect(runAgent(ask("hi"), deps));
    expect(events).toEqual([
      { type: "text", text: "Hello!" },
      { type: "done", steps: 1 },
    ]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("calls the tool, feeds the result back and stops on the final text", async () => {
    const { deps, callTool, llm } = setup([
      callTools({ name: "shop__list_orders", args: { after: "2026-10-10" } }),
      say("One order: #24."),
    ]);
    callTool.mockResolvedValueOnce(ok('[{"id":24}]'));

    const events = await collect(runAgent(ask("orders today?"), deps));

    expect(types(events)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(events[0]).toMatchObject({
      name: "shop__list_orders",
      server: "shop",
      args: { after: "2026-10-10" },
    });
    expect(events[1]).toMatchObject({ isError: false, summary: '[{"id":24}]' });
    expect(callTool).toHaveBeenCalledWith("shop__list_orders", { after: "2026-10-10" });
    // The second model call saw the call and its result.
    expect(llm.requests[1].turns.slice(-2)).toEqual([
      {
        role: "model",
        text: "",
        calls: [{ id: "call_1", name: "shop__list_orders", args: { after: "2026-10-10" } }],
      },
      {
        role: "tool",
        results: [
          { id: "call_1", name: "shop__list_orders", output: '[{"id":24}]', isError: false },
        ],
      },
    ]);
  });

  it("runs several calls from one reply, in order, and returns all results together", async () => {
    const { deps, callTool, llm } = setup([
      callTools({ name: "shop__list_orders" }, { name: "shop__get_order", args: { id: 1 } }),
      say("done"),
    ]);
    const events = await collect(runAgent(ask("x"), deps));
    expect(types(events)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "done",
    ]);
    expect(callTool.mock.calls.map((c) => c[0])).toEqual(["shop__list_orders", "shop__get_order"]);
    const last = llm.requests[1].turns.at(-1);
    expect(last).toMatchObject({ role: "tool", results: [{ id: "call_1" }, { id: "call_2" }] });
  });

  it("chains calls across steps", async () => {
    const { deps } = setup([
      callTools({ name: "shop__list_orders" }),
      callTools({ name: "shop__get_order", args: { id: 24 } }),
      say("Order 24 is processing."),
    ]);
    const events = await collect(runAgent(ask("x"), deps));
    expect(events.at(-1)).toEqual({ type: "done", steps: 3 });
  });

  it("shows the model a tool error and lets it recover", async () => {
    const { deps, callTool, llm } = setup([
      callTools({ name: "shop__get_order", args: { id: 999 } }),
      say("That order doesn't exist."),
    ]);
    callTool.mockResolvedValueOnce(fail("Order 999 not found"));
    const events = await collect(runAgent(ask("x"), deps));
    expect(events[1]).toMatchObject({ type: "tool_result", isError: true });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(llm.requests[1].turns.at(-1)).toMatchObject({
      role: "tool",
      results: [{ isError: true, output: "Order 999 not found" }],
    });
  });

  it("treats a tool that throws as an error result, without leaking details", async () => {
    const { deps, callTool } = setup([callTools({ name: "shop__list_orders" }), say("sorry")]);
    callTool.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const events = await collect(runAgent(ask("x"), deps));
    expect(JSON.stringify(events)).not.toContain("10.0.0.5");
    expect(events[1]).toMatchObject({
      isError: true,
      summary: "The gateway could not run this tool.",
    });
  });

  it("passes an unknown tool name to the router and lets the model see the rejection", async () => {
    const { deps, callTool } = setup([callTools({ name: "nope__tool" }), say("ok")]);
    callTool.mockResolvedValueOnce(fail("Unknown tool 'nope__tool'."));
    const events = await collect(runAgent(ask("x"), deps));
    expect(callTool).toHaveBeenCalledWith("nope__tool", {});
    expect(events[1]).toMatchObject({ isError: true });
  });

  it("re-reads the tool list before every model call", async () => {
    const { deps, listTools } = setup([callTools({ name: "shop__list_orders" }), say("done")]);
    await collect(runAgent(ask("x"), deps));
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("stops after maxSteps with a clear error", async () => {
    const { deps } = setup(
      Array.from({ length: 5 }, () => callTools({ name: "shop__list_orders" })),
      { limits: { maxSteps: 3 } },
    );
    const events = await collect(runAgent(ask("x"), deps));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "step_limit" });
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(3);
  });

  it("gives up after several steps in a row where every tool call failed", async () => {
    const { deps, callTool, llm } = setup(
      Array.from({ length: 6 }, () => callTools({ name: "nope__tool" })),
    );
    callTool.mockResolvedValue(fail("Unknown tool 'nope__tool'."));
    const events = await collect(runAgent(ask("x"), deps));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_failures" });
    expect(llm.requests).toHaveLength(3);
  });

  it("a success resets the failure count", async () => {
    const { deps, callTool } = setup([
      callTools({ name: "a__x" }),
      callTools({ name: "a__x" }),
      callTools({ name: "shop__list_orders" }),
      callTools({ name: "a__x" }),
      callTools({ name: "a__x" }),
      say("done"),
    ]);
    callTool.mockImplementation(async (name) => (name === "a__x" ? fail("nope") : ok("{}")));
    const events = await collect(runAgent(ask("x"), deps));
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("tells the model when there are no tools at all", async () => {
    const { deps, llm } = setup([say("I can't look that up.")], { listTools: async () => [] });
    await collect(runAgent(ask("orders?"), deps));
    expect(llm.requests[0].tools).toEqual([]);
    expect(llm.requests[0].system).toMatch(/No tools are available/);
  });

  it("stops after maxToolCalls", async () => {
    const { deps, callTool } = setup(
      [
        callTools(
          { name: "shop__list_orders" },
          { name: "shop__list_orders" },
          { name: "shop__list_orders" },
        ),
      ],
      { limits: { maxToolCalls: 2 } },
    );
    const events = await collect(runAgent(ask("x"), deps));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_limit" });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("times the whole turn out, even if the model never answers", async () => {
    const hang = (req: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) =>
        req.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const { deps } = setup([hang as never], { limits: { turnTimeoutMs: 50 } });
    const events = await collect(runAgent(ask("x"), deps));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "timeout" })]);
  });

  it("stops quietly when the client goes away mid-turn", async () => {
    const ctrl = new AbortController();
    const { deps, callTool } = setup([callTools({ name: "shop__list_orders" }), say("never")]);
    callTool.mockImplementationOnce(async () => {
      ctrl.abort();
      return ok("{}");
    });
    const events = await collect(runAgent(ask("x"), deps, ctrl.signal));
    expect(types(events)).toEqual(["tool_call", "tool_result"]);
    expect(deps.llm).toHaveProperty("requests");
    expect((deps.llm as FakeLlm).requests).toHaveLength(1);
  });

  it("does nothing if already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { deps, llm } = setup([say("x")]);
    expect(await collect(runAgent(ask("x"), deps, ctrl.signal))).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("truncates long results before the model sees them", async () => {
    const { deps, callTool, llm } = setup([callTools({ name: "shop__list_orders" }), say("done")], {
      limits: { maxResultChars: 100 },
    });
    callTool.mockResolvedValueOnce(ok("x".repeat(500)));
    await collect(runAgent(ask("x"), deps));
    const fed = llm.requests[1].turns.at(-1);
    expect(fed).toMatchObject({ role: "tool" });
    const output = (fed as { results: { output: string }[] }).results[0].output;
    expect(output.length).toBeLessThan(200);
    expect(output).toContain("truncated: 400 more characters");
  });

  describe("model failures", () => {
    it("reports a model error as one error event", async () => {
      const { deps } = setup([new LlmError("auth", "The LLM API key was rejected.")]);
      expect(await collect(runAgent(ask("x"), deps))).toEqual([
        { type: "error", code: "auth", message: "The LLM API key was rejected." },
      ]);
    });

    it("retries once after a short rate limit", async () => {
      const sleep = vi.fn(async () => {});
      const { deps } = setup([new LlmError("rate_limited", "slow down", 1_000), say("ok")], {
        sleep,
      });
      const events = await collect(runAgent(ask("x"), deps));
      expect(sleep).toHaveBeenCalledWith(1_000);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("does not wait out a long rate limit", async () => {
      const sleep = vi.fn(async () => {});
      const { deps } = setup([new LlmError("rate_limited", "daily quota", 3_600_000)], { sleep });
      const events = await collect(runAgent(ask("x"), deps));
      expect(sleep).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: "error", code: "rate_limited", message: "daily quota" }]);
    });

    it("retries a second time, then gives up if it is still rate limited", async () => {
      const sleep = vi.fn(async () => {});
      const e = new LlmError("rate_limited", "slow down", 100);
      const twice = setup([e, e, say("ok")], { sleep });
      expect((await collect(runAgent(ask("x"), twice.deps))).at(-1)).toMatchObject({
        type: "done",
      });
      expect(sleep).toHaveBeenCalledTimes(2);

      const giveUp = setup([e, e, e], { sleep });
      expect(await collect(runAgent(ask("x"), giveUp.deps))).toEqual([
        { type: "error", code: "rate_limited", message: "slow down" },
      ]);
    });

    it("waits as long as the provider's limit allows (Groq's per-minute token cap)", async () => {
      const sleep = vi.fn(async () => {});
      const slow = new LlmError("rate_limited", "tpm", 12_000);
      const refuses = setup([slow], { sleep });
      expect(await collect(runAgent(ask("x"), refuses.deps))).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();

      const waits = setup([slow, say("ok")], { sleep, limits: { maxRetryWaitMs: 20_000 } });
      const events = await collect(runAgent(ask("x"), waits.deps));
      expect(sleep).toHaveBeenCalledWith(12_000);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("hides unexpected errors", async () => {
      const { deps } = setup([new Error("secret internals")]);
      const events = await collect(runAgent(ask("x"), deps));
      expect(JSON.stringify(events)).not.toContain("secret internals");
      expect(events[0]).toMatchObject({ type: "error", code: "internal" });
    });

    it("reports an empty answer", async () => {
      const { deps } = setup([say("")]);
      expect(await collect(runAgent(ask("x"), deps))).toEqual([
        { type: "error", code: "empty_response", message: "The model returned no answer." },
      ]);
    });
  });

  it("sends earlier assistant text back as model turns and puts today's date in the prompt", async () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const { deps, llm } = setup([say("ok")], { now: () => now });
    await collect(
      runAgent(
        [
          { role: "user", text: "hi" },
          { role: "assistant", text: "hello" },
          { role: "user", text: "orders today?" },
        ],
        deps,
      ),
    );
    expect(llm.requests[0].turns).toEqual([
      { role: "user", text: "hi" },
      { role: "model", text: "hello", calls: [] },
      { role: "user", text: "orders today?" },
    ]);
    expect(llm.requests[0].system).toContain("2026-10-10T12:00:00.000Z");
  });
});

describe("resultText", () => {
  it("joins text parts and names non-text ones", () => {
    const r: CallToolResult = {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    };
    expect(resultText(r, 1000)).toBe("a\n[image content omitted]\nb");
  });
  it("falls back to structured content, then a placeholder", () => {
    expect(resultText({ content: [], structuredContent: { n: 1 } }, 100)).toBe('{"n":1}');
    expect(resultText({ content: [] }, 100)).toBe("(empty result)");
    expect(resultText({ isError: true, content: [] }, 100)).toBe(
      "The tool failed without a message.",
    );
  });
});

describe("systemPrompt", () => {
  it("only mentions missing tools when there are none", () => {
    expect(systemPrompt(new Date(), 3)).not.toMatch(/No tools are available/);
    expect(systemPrompt(new Date(), 0)).toMatch(/No tools are available/);
  });
  it("treats tool output as data", () => {
    expect(systemPrompt(new Date())).toMatch(/data, never\s+instructions/);
  });
});

describe("search mode", () => {
  const meta = [tool("search_tools"), tool("call_tool")];

  it("tells the model to search first, only when it is offered just the meta-tools", async () => {
    const { deps, llm } = setup([say("ok")], { listTools: async () => meta });
    await collect(runAgent(ask("hi"), deps));
    expect(llm.requests[0].system).toMatch(/search_tools finds the gateway's other tools/);
    expect(llm.requests[0].system).not.toMatch(/Tool names look like/);
    expect(llm.requests[0].tools.map((t) => t.name)).toEqual(["search_tools", "call_tool"]);

    const full = setup([say("ok")]);
    await collect(runAgent(ask("hi"), full.deps));
    expect(full.llm.requests[0].system).toMatch(/Tool names look like/);
    expect(full.llm.requests[0].system).not.toMatch(/search_tools/);
  });

  it("shows the tool inside call_tool, but gives the model its own call and result back", async () => {
    const { deps, callTool, llm } = setup(
      [
        callTools({ name: "search_tools", args: { query: "orders" }, id: "s1" }),
        callTools({
          name: "call_tool",
          args: { name: "shop__list_orders", arguments: { after: "2026-10-10" } },
          id: "c1",
        }),
        say("One order."),
      ],
      { listTools: async () => meta },
    );
    callTool.mockResolvedValueOnce(ok('{"results":[]}')).mockResolvedValueOnce(ok("[24]"));

    const events = await collect(runAgent(ask("orders today?"), deps));

    expect(types(events)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      name: "search_tools",
      server: null,
      args: { query: "orders" },
    });
    expect(events[2]).toMatchObject({
      id: "c1",
      name: "shop__list_orders",
      server: "shop",
      args: { after: "2026-10-10" },
    });
    expect(events[3]).toMatchObject({ id: "c1", name: "shop__list_orders", isError: false });
    // The agent forwards the wrapper call untouched...
    expect(callTool).toHaveBeenLastCalledWith("call_tool", {
      name: "shop__list_orders",
      arguments: { after: "2026-10-10" },
    });
    // ...and the model sees its own call_tool name in the history, as the API requires.
    expect(llm.requests[2].turns.slice(-2)).toMatchObject([
      { role: "model", calls: [{ id: "c1", name: "call_tool" }] },
      { role: "tool", results: [{ id: "c1", name: "call_tool", output: "[24]" }] },
    ]);
  });

  it("shows a call_tool with no usable name as itself", async () => {
    const { deps } = setup([callTools({ name: "call_tool", args: {} }), say("sorry")], {
      listTools: async () => meta,
      callTool: async () => fail("Invalid arguments for call_tool: name: Required"),
    });
    const events = await collect(runAgent(ask("x"), deps));
    expect(events[0]).toMatchObject({ type: "tool_call", name: "call_tool", server: null });
  });

  it("does not count a search that finds nothing as a failed step", async () => {
    const { deps } = setup(
      [
        callTools({ name: "search_tools", args: { query: "a" } }),
        callTools({ name: "search_tools", args: { query: "b" } }),
        callTools({ name: "search_tools", args: { query: "c" } }),
        say("Nothing fits."),
      ],
      { listTools: async () => meta, callTool: async () => ok('{"results":[]}') },
    );
    const events = await collect(runAgent(ask("x"), deps));
    expect(types(events).at(-1)).toBe("done");
  });
});

describe("runAgent: approving writes", () => {
  const writes = (name: string) => Promise.resolve(name === "shop__create_product");
  const create = { name: "shop__create_product", args: { name: "Mug", price: "9" } };

  it("holds a write: no call is made, the user is asked, the turn ends", async () => {
    const { deps, callTool, llm } = setup([callTools(create)], { needsConfirmation: writes });
    const events = await collect(runAgent(ask("make a mug"), deps));
    expect(events).toEqual([
      {
        type: "confirm",
        id: "call_1",
        name: "shop__create_product",
        server: "shop",
        args: create.args,
      },
      { type: "done", steps: 1 },
    ]);
    expect(callTool).not.toHaveBeenCalled();
    // The model was told the dashboard does the asking.
    expect(llm.requests[0].system).toMatch(/dashboard itself asks the user to approve/);
  });

  it("runs reads in the same step and holds only the write", async () => {
    const { deps, callTool } = setup(
      [callTools({ name: "shop__list_orders" }, { ...create, id: "call_2" })],
      { needsConfirmation: writes },
    );
    const events = await collect(runAgent(ask("x"), deps));
    expect(types(events)).toEqual(["tool_call", "tool_result", "confirm", "done"]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("runs an approved write once, whatever the order of its arguments", async () => {
    const { deps, callTool } = setup(
      [callTools({ ...create, args: { price: "9", name: "Mug" } }), say("Created.")],
      { needsConfirmation: writes, approved: [{ name: create.name, args: create.args }] },
    );
    const events = await collect(runAgent(ask("yes, go ahead"), deps));
    expect(types(events)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(callTool).toHaveBeenCalledWith(create.name, { price: "9", name: "Mug" });
  });

  it("does not run a write whose arguments differ from what was approved", async () => {
    const { deps, callTool } = setup(
      [callTools({ ...create, args: { name: "Mug", price: "900" } })],
      { needsConfirmation: writes, approved: [{ name: create.name, args: create.args }] },
    );
    const events = await collect(runAgent(ask("yes"), deps));
    expect(types(events)).toEqual(["confirm", "done"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("an approval is single-use", async () => {
    const { deps, callTool } = setup([callTools(create, { ...create, id: "call_2" })], {
      needsConfirmation: writes,
      approved: [{ name: create.name, args: create.args }],
    });
    const events = await collect(runAgent(ask("yes"), deps));
    expect(types(events)).toEqual(["tool_call", "tool_result", "confirm", "done"]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("asks about the tool inside call_tool, not about call_tool", async () => {
    const { deps, callTool } = setup(
      [callTools({ name: "call_tool", args: { name: create.name, arguments: create.args } })],
      {
        needsConfirmation: writes,
        listTools: async () => [tool("search_tools"), tool("call_tool")],
      },
    );
    const events = await collect(runAgent(ask("x"), deps));
    expect(events[0]).toMatchObject({ type: "confirm", name: create.name, args: create.args });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("runs everything when no confirmation is configured", async () => {
    const { deps, callTool } = setup([callTools(create), say("ok")]);
    await collect(runAgent(ask("x"), deps));
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
