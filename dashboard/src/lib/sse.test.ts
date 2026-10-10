import { describe, expect, it } from "vitest";
import { SseParser, type SseMessage } from "./sse";

const wire =
  ': ping\n\nevent: tool_call\ndata: {"a":1}\n\nevent: text\ndata: {"text":"héllo ✓"}\n\nevent: done\ndata: {"steps":1}\n\n';
const expected: SseMessage[] = [
  { event: "tool_call", data: '{"a":1}' },
  { event: "text", data: '{"text":"héllo ✓"}' },
  { event: "done", data: '{"steps":1}' },
];

function collect(chunks: (string | Uint8Array)[]) {
  const parser = new SseParser();
  return chunks.flatMap((c) => parser.push(c));
}

describe("SseParser", () => {
  it("parses a whole stream and ignores comment lines", () => {
    expect(collect([wire])).toEqual(expected);
  });

  it("gives the same result however the text is chunked", () => {
    for (let size = 1; size <= 12; size++) {
      const chunks = wire.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!;
      expect(collect(chunks), `chunk size ${size}`).toEqual(expected);
    }
  });

  it("copes with a multi-byte character split across byte chunks", () => {
    const bytes = new TextEncoder().encode(wire);
    for (let split = 1; split < bytes.length; split++) {
      expect(collect([bytes.slice(0, split), bytes.slice(split)]), `split at ${split}`).toEqual(
        expected,
      );
    }
  });

  it("handles CRLF line endings, even when \\r and \\n arrive separately", () => {
    expect(collect(["event: a\r\ndata: 1\r\n\r\n"])).toEqual([{ event: "a", data: "1" }]);
    expect(collect(["event: a\r", "\ndata: 1\r", "\n\r", "\n"])).toEqual([
      { event: "a", data: "1" },
    ]);
  });

  it("joins multi-line data and defaults the event name", () => {
    expect(collect(["data: one\ndata: two\n\n"])).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  it("holds back an incomplete message until its blank line arrives", () => {
    const parser = new SseParser();
    expect(parser.push("event: text\ndata: {}")).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "text", data: "{}" }]);
  });

  it("skips blocks with no data", () => {
    expect(collect(["event: x\n\n", ": only a comment\n\n"])).toEqual([]);
  });
});
