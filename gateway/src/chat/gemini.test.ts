import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSchema, fromResponse, GeminiClient, toRequestBody } from "./gemini.js";
import { LlmError } from "./types.js";

const KEY = "AIza-test-secret-key-123";

interface Seen {
  url?: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

let server: Server | undefined;
afterEach(() => server?.close());

/** A local stand-in for Gemini that answers with `reply` and records what it was sent. */
async function fakeGemini(reply: {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}) {
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
  return { seen, client: new GeminiClient({ apiKey: KEY, model: "gemini-test", baseUrl }) };
}

const tool: Tool = {
  name: "shop__list_orders",
  description: "[Shop] List orders",
  inputSchema: {
    type: "object",
    properties: { after: { type: "string" } },
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  } as Tool["inputSchema"],
};

const answer = (parts: unknown[]) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
});

describe("request mapping", () => {
  it("maps every turn kind, keeps signatures and puts the key in a header only", async () => {
    const { client, seen } = await fakeGemini({ body: answer([{ text: "hi" }]) });
    await client.generate({
      system: "SYS",
      tools: [tool],
      turns: [
        { role: "user", text: "orders?" },
        {
          role: "model",
          text: "",
          calls: [{ id: "c1", name: "shop__list_orders", args: { after: "x" }, signature: "SIG" }],
        },
        {
          role: "tool",
          results: [
            { id: "c1", name: "shop__list_orders", output: "[]", isError: false },
            { id: "c2", name: "shop__list_orders", output: "boom", isError: true },
          ],
        },
      ],
    });

    expect(seen[0].url).toBe("/v1beta/models/gemini-test:generateContent");
    expect(seen[0].url).not.toContain(KEY);
    expect(seen[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(seen[0].body).toEqual({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [
        { role: "user", parts: [{ text: "orders?" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: { id: "c1", name: "shop__list_orders", args: { after: "x" } },
              thoughtSignature: "SIG",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: { id: "c1", name: "shop__list_orders", response: { result: "[]" } },
            },
            {
              functionResponse: {
                id: "c2",
                name: "shop__list_orders",
                response: { error: "boom" },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "shop__list_orders",
              description: "[Shop] List orders",
              parametersJsonSchema: {
                type: "object",
                properties: { after: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    });
  });

  it("omits tools entirely when there are none", () => {
    const body = toRequestBody({ system: "s", tools: [], turns: [{ role: "user", text: "x" }] });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("toolConfig");
  });

  it("removes $schema/$id at any depth but leaves real keywords", () => {
    expect(
      cleanSchema({
        $schema: "x",
        properties: { a: { $id: "y", anyOf: [{ type: "string" }, { type: "null" }] } },
      }),
    ).toEqual({ properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } });
  });
});

describe("response mapping", () => {
  it("returns text", () => {
    expect(fromResponse(answer([{ text: "Hello " }, { text: "world" }]))).toEqual({
      text: "Hello world",
      calls: [],
    });
  });

  it("returns calls with ids, args and signatures, and ignores thought text", () => {
    expect(
      fromResponse(
        answer([
          { text: "thinking…", thought: true },
          { functionCall: { id: "abc", name: "a__b", args: { n: 1 } }, thoughtSignature: "S" },
          { functionCall: { name: "a__c" } },
        ]),
      ),
    ).toEqual({
      text: "",
      calls: [
        { id: "abc", name: "a__b", args: { n: 1 }, signature: "S" },
        { id: "call_2", name: "a__c", args: {} },
      ],
    });
  });

  it.each([
    ["a blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }],
    ["no candidates", { candidates: [] }],
    ["a non-STOP finish with no content", { candidates: [{ finishReason: "SAFETY" }] }],
  ])("raises 'blocked' for %s", (_name, body) => {
    expect(() => fromResponse(body)).toThrow(expect.objectContaining({ kind: "blocked" }));
  });

  it("raises 'unavailable' for an unreadable body", () => {
    expect(() => fromResponse(undefined)).toThrow(LlmError);
  });
});

describe("error mapping", () => {
  const cases: [number, string, Record<string, string>?][] = [
    [429, "rate_limited", { "retry-after": "3" }],
    [401, "auth"],
    [403, "auth"],
    [400, "bad_request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ];
  it.each(cases)("HTTP %i -> %s, never echoing the key", async (status, kind, headers) => {
    const { client } = await fakeGemini({
      status,
      headers,
      body: { error: { message: "details here" } },
    });
    const err = await client
      .generate({ system: "s", tools: [], turns: [{ role: "user", text: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe(kind);
    expect((err as LlmError).message).not.toContain(KEY);
    if (status === 429) expect((err as LlmError).retryAfterMs).toBe(3000);
  });

  it("treats Google's HTTP 400 'API key not valid' as an auth problem, not a bad request", async () => {
    const { client } = await fakeGemini({
      status: 400,
      body: { error: { message: "API key not valid. Please pass a valid API key." } },
    });
    const err = await client
      .generate({ system: "s", tools: [], turns: [{ role: "user", text: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "auth" });
  });

  it("maps a refused connection to 'unavailable'", async () => {
    const client = new GeminiClient({ apiKey: KEY, model: "m", baseUrl: "http://127.0.0.1:1" });
    const err = await client
      .generate({ system: "s", tools: [], turns: [{ role: "user", text: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
    expect((err as Error).message).not.toContain(KEY);
  });

  it("times out a hung request", async () => {
    server = createServer(() => {});
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const client = new GeminiClient({
      apiKey: KEY,
      model: "m",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requestTimeoutMs: 100,
    });
    server.closeAllConnections?.();
    const err = await client
      .generate({ system: "s", tools: [], turns: [{ role: "user", text: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
  });
});
