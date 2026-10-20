import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { fromResponse, GroqClient, retryHint, toRequestBody } from "./groq.js";
import { LlmError } from "./types.js";

const KEY = "gsk_test_secret_key_123";

interface Seen {
  url?: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

let server: Server | undefined;
afterEach(() => server?.close());

/** A local stand-in for Groq that answers with `reply` and records what it was sent. */
async function fakeGroq(
  reply: { status?: number; headers?: Record<string, string>; body: unknown },
  opts: { model?: string; reasoningEffort?: string } = {},
) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || "null") });
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    client: new GroqClient({
      apiKey: KEY,
      model: opts.model ?? "openai/gpt-oss-120b",
      baseUrl,
      ...opts,
    }),
  };
}

const tool: Tool = {
  name: "woocommerce__list_orders",
  description: "List orders",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { after: { type: "string" } },
  },
};

const message = (m: unknown, finish = "stop") => ({
  choices: [{ message: m, finish_reason: finish }],
});

interface WireBody {
  model: string;
  messages: unknown[];
  tool_choice: string;
  tools: { function: { parameters: unknown } }[];
}

describe("toRequestBody", () => {
  it("sends the system prompt, turns, tools and tool_choice in OpenAI format", () => {
    const body = toRequestBody(
      {
        system: "be helpful",
        tools: [tool],
        turns: [
          { role: "user", text: "orders today?" },
          {
            role: "model",
            text: "",
            calls: [{ id: "c1", name: "woocommerce__list_orders", args: { after: "2026-10-19" } }],
          },
          {
            role: "tool",
            results: [
              { id: "c1", name: "woocommerce__list_orders", output: '{"count":1}', isError: false },
              { id: "c2", name: "x", output: "boom", isError: true },
            ],
          },
        ],
      },
      { model: "openai/gpt-oss-120b" },
    ) as unknown as WireBody;

    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(body.messages[1]).toEqual({ role: "user", content: "orders today?" });
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "woocommerce__list_orders", arguments: '{"after":"2026-10-19"}' },
        },
      ],
    });
    // One tool message per result, tied to its call; errors are labelled.
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"count":1}' });
    expect(body.messages[4]).toEqual({ role: "tool", tool_call_id: "c2", content: "Error: boom" });
    expect(body.tool_choice).toBe("auto");
    // JSON Schema keywords the API doesn't want are stripped.
    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { after: { type: "string" } },
    });
  });

  it("omits tools when there are none", () => {
    const body = toRequestBody({ system: "s", turns: [], tools: [] }, { model: "m" });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("sends reasoning_effort only for gpt-oss models", () => {
    const req = { system: "s", turns: [], tools: [] };
    expect(
      toRequestBody(req, { model: "openai/gpt-oss-120b", reasoningEffort: "low" }),
    ).toMatchObject({
      reasoning_effort: "low",
    });
    expect(
      toRequestBody(req, { model: "llama-3.3-70b-versatile", reasoningEffort: "low" }),
    ).not.toHaveProperty("reasoning_effort");
    expect(toRequestBody(req, { model: "openai/gpt-oss-120b" })).not.toHaveProperty(
      "reasoning_effort",
    );
  });
});

describe("fromResponse", () => {
  it("returns text", () => {
    expect(fromResponse(message({ content: "hello" }))).toEqual({ text: "hello", calls: [] });
  });

  it("parses tool calls and their JSON arguments", () => {
    const reply = fromResponse(
      message(
        {
          content: null,
          tool_calls: [
            {
              id: "abc",
              type: "function",
              function: { name: "search_tools", arguments: '{"query":"order"}' },
            },
            { type: "function", function: { name: "t", arguments: "" } },
          ],
        },
        "tool_calls",
      ),
    );
    expect(reply.calls).toEqual([
      { id: "abc", name: "search_tools", args: { query: "order" } },
      { id: "call_2", name: "t", args: {} },
    ]);
  });

  it("rejects arguments that are not valid JSON", () => {
    expect(() =>
      fromResponse(
        message({ tool_calls: [{ id: "a", function: { name: "t", arguments: "{oops" } }] }),
      ),
    ).toThrowError(/malformed tool call/);
  });

  it("throws on an unreadable body, no choices, or a stop with nothing", () => {
    expect(() => fromResponse(undefined)).toThrow(LlmError);
    expect(() => fromResponse({ choices: [] })).toThrow(LlmError);
    expect(() => fromResponse(message({ content: "" }, "length"))).toThrowError(/length/);
    expect(fromResponse(message({ content: "" }, "stop"))).toEqual({ text: "", calls: [] });
  });
});

describe("GroqClient", () => {
  it("posts to chat/completions with the key in the Authorization header only", async () => {
    const { seen, client } = await fakeGroq({ body: message({ content: "ok" }) });
    const reply = await client.generate({
      system: "s",
      turns: [{ role: "user", text: "hi" }],
      tools: [tool],
    });
    expect(reply.text).toBe("ok");
    expect(seen[0]!.url).toBe("/openai/v1/chat/completions");
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(seen[0]!.body)).not.toContain(KEY);
  });

  it.each([
    [429, { error: { message: "slow down" } }, "rate_limited"],
    [401, { error: { message: "Invalid API Key" } }, "auth"],
    [403, { error: { message: "nope" } }, "auth"],
    [404, { error: { message: "model_not_found" } }, "bad_request"],
    [
      400,
      { error: { code: "tool_use_failed", message: "Failed to call a function" } },
      "bad_request",
    ],
    [500, { error: { message: "boom" } }, "unavailable"],
  ])("maps HTTP %i to %s without leaking the key", async (status, body, kind) => {
    const { client } = await fakeGroq({ status, body, headers: { "retry-after": "7" } });
    const err = await client.generate({ system: "s", turns: [], tools: [] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe(kind);
    expect((err as LlmError).message).not.toContain(KEY);
    if (kind === "rate_limited") expect((err as LlmError).retryAfterMs).toBe(7000);
  });

  it("reports an unreachable API as unavailable", async () => {
    const client = new GroqClient({ apiKey: KEY, model: "m", baseUrl: "http://127.0.0.1:1" });
    const err = await client
      .generate({ system: "s", turns: [], tools: [] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
  });
});

describe("retryHint", () => {
  it.each([
    ["Rate limit reached. Please try again in 6.52s. Need more tokens?", 6520],
    ["Please try again in 850ms.", 850],
    ["Please try again in 1m3.5s.", 63500],
    ["Please try again in 2m.", 120000],
    ["quota exhausted", undefined],
    [undefined, undefined],
  ])("%j -> %j ms", (text, ms) => {
    expect(retryHint(text)).toBe(ms);
  });
});

describe("GroqClient rate limits", () => {
  it("reads the wait from the message when there is no retry-after header", async () => {
    const { client } = await fakeGroq({
      status: 429,
      body: {
        error: { message: "Rate limit reached for tokens per minute. Please try again in 7.5s." },
      },
    });
    const err = await client
      .generate({ system: "s", turns: [], tools: [] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterMs: 7500 });
  });
});
