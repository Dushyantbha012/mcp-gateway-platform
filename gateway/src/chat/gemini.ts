import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { LlmError, type LlmClient, type LlmReply, type LlmRequest, type Turn } from "./types.js";

export const DEFAULT_GEMINI_URL = "https://generativelanguage.googleapis.com";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Per request, on top of the turn's own deadline. */
  requestTimeoutMs?: number;
}

/**
 * Gemini's `generateContent` REST API, called with plain `fetch`: no SDK to
 * pin, and tests can point `baseUrl` at a local fake. This file is the only
 * place that knows Gemini's wire format.
 */
export class GeminiClient implements LlmClient {
  constructor(private readonly opts: GeminiOptions) {}

  async generate(req: LlmRequest): Promise<LlmReply> {
    const { apiKey, model, baseUrl = DEFAULT_GEMINI_URL, requestTimeoutMs = 60_000 } = this.opts;
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        // The key goes in a header, never in the URL, so it can't end up in
        // a logged URL or an error message that quotes one.
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(toRequestBody(req)),
        signal,
      });
    } catch (err) {
      // Let the caller's own abort/deadline be recognised as such.
      if (req.signal?.aborted) throw err;
      throw new LlmError("unavailable", "Could not reach the Gemini API. Try again shortly.");
    }

    if (!res.ok) throw await toError(res);
    return fromResponse(await res.json().catch(() => undefined));
  }
}

/** The subset of JSON Schema Gemini accepts is wider with `parametersJsonSchema`; drop what it rejects. */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$schema" || k === "$id") continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return schema;
}

function declaration(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parametersJsonSchema: cleanSchema(tool.inputSchema),
  };
}

function toContents(turns: Turn[]) {
  return turns.map((turn) => {
    switch (turn.role) {
      case "user":
        return { role: "user", parts: [{ text: turn.text }] };
      case "model": {
        const parts: Record<string, unknown>[] = [];
        if (turn.text) parts.push({ text: turn.text });
        for (const c of turn.calls) {
          parts.push({
            functionCall: { id: c.id, name: c.name, args: c.args },
            // Must be returned with the call it came with (Gemini 3).
            ...(c.signature ? { thoughtSignature: c.signature } : {}),
          });
        }
        return { role: "model", parts };
      }
      case "tool":
        return {
          role: "user",
          parts: turn.results.map((r) => ({
            functionResponse: {
              id: r.id,
              name: r.name,
              response: r.isError ? { error: r.output } : { result: r.output },
            },
          })),
        };
    }
  });
}

export function toRequestBody(req: LlmRequest) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toContents(req.turns),
    ...(req.tools.length
      ? {
          tools: [{ functionDeclarations: req.tools.map(declaration) }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        }
      : {}),
  };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
}

export function fromResponse(body: unknown): LlmReply {
  const b = body as
    | {
        promptFeedback?: { blockReason?: string };
        candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      }
    | undefined;
  if (!b) throw new LlmError("unavailable", "The Gemini API returned an unreadable response.");
  if (b.promptFeedback?.blockReason) {
    throw new LlmError("blocked", "Gemini declined to answer this request.");
  }
  const candidate = b.candidates?.[0];
  if (!candidate) throw new LlmError("blocked", "Gemini returned no answer.");

  let text = "";
  const calls: LlmReply["calls"] = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.functionCall) {
      calls.push({
        id: part.functionCall.id ?? `call_${calls.length + 1}`,
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
      });
    } else if (part.text && !part.thought) {
      text += part.text;
    }
  }
  if (!text && calls.length === 0) {
    const reason = candidate.finishReason;
    if (reason && reason !== "STOP") {
      throw new LlmError("blocked", `Gemini stopped without an answer (${reason}).`);
    }
  }
  return { text, calls };
}

async function toError(res: Response): Promise<LlmError> {
  const body = (await res.json().catch(() => undefined)) as
    { error?: { message?: string } } | undefined;
  const detail = body?.error?.message?.slice(0, 300);
  switch (true) {
    case res.status === 429: {
      const retry = Number(res.headers.get("retry-after"));
      return new LlmError(
        "rate_limited",
        "The Gemini API rate limit or daily quota was reached. Try again later.",
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      );
    }
    case res.status === 401 || res.status === 403:
      return new LlmError("auth", "The Gemini API rejected the gateway's API key.");
    case res.status === 400 || res.status === 404:
      return new LlmError(
        "bad_request",
        `Gemini rejected the request${detail ? `: ${detail}` : ""}.`,
      );
    default:
      return new LlmError(
        "unavailable",
        `The Gemini API failed (HTTP ${res.status}). Try again shortly.`,
      );
  }
}
