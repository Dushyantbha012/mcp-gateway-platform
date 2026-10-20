import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../logger.js";
import { cleanSchema } from "./gemini.js";
import { LlmError, type LlmClient, type LlmReply, type LlmRequest, type Turn } from "./types.js";

export const DEFAULT_GROQ_URL = "https://api.groq.com";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

export interface GroqOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * `low | medium | high`, for the gpt-oss reasoning models only (other models
   * reject the parameter). Lower is faster and spends fewer tokens per step.
   */
  reasoningEffort?: string;
  /** Per request, on top of the turn's own deadline. */
  requestTimeoutMs?: number;
}

/**
 * Groq's OpenAI-compatible `chat/completions` API, called with plain `fetch`
 * (no SDK to pin; tests point `baseUrl` at a local fake). This file is the only
 * place that knows Groq's wire format.
 */
export class GroqClient implements LlmClient {
  constructor(private readonly opts: GroqOptions) {}

  async generate(req: LlmRequest): Promise<LlmReply> {
    const { apiKey, baseUrl = DEFAULT_GROQ_URL, requestTimeoutMs = 60_000 } = this.opts;
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
        method: "POST",
        // The key goes in a header, never in the URL or an error message.
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(toRequestBody(req, this.opts)),
        signal,
      });
    } catch (err) {
      // Let the caller's own abort/deadline be recognised as such.
      if (req.signal?.aborted) throw err;
      throw new LlmError("unavailable", "Could not reach the Groq API. Try again shortly.");
    }

    if (!res.ok) throw await toError(res);
    return fromResponse(await res.json().catch(() => undefined));
  }
}

function toolDefinition(tool: Tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: cleanSchema(tool.inputSchema),
    },
  };
}

function toMessages(system: string, turns: Turn[]) {
  const messages: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    switch (turn.role) {
      case "user":
        messages.push({ role: "user", content: turn.text });
        break;
      case "model":
        messages.push({
          role: "assistant",
          content: turn.text || null,
          ...(turn.calls.length
            ? {
                tool_calls: turn.calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        });
        break;
      case "tool":
        // One message per result, each tied to its call by id.
        for (const r of turn.results) {
          messages.push({
            role: "tool",
            tool_call_id: r.id,
            content: r.isError ? `Error: ${r.output}` : r.output,
          });
        }
        break;
    }
  }
  return messages;
}

export function toRequestBody(
  req: LlmRequest,
  opts: Pick<GroqOptions, "model" | "reasoningEffort">,
) {
  return {
    model: opts.model,
    messages: toMessages(req.system, req.turns),
    ...(req.tools.length ? { tools: req.tools.map(toolDefinition), tool_choice: "auto" } : {}),
    // Only the gpt-oss models take it; any other model would answer 400.
    ...(opts.reasoningEffort && /gpt-oss/i.test(opts.model)
      ? { reasoning_effort: opts.reasoningEffort }
      : {}),
  };
}

interface GroqToolCall {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

export function fromResponse(body: unknown): LlmReply {
  const b = body as
    | {
        choices?: {
          message?: { content?: string | null; tool_calls?: GroqToolCall[] };
          finish_reason?: string;
        }[];
      }
    | undefined;
  if (!b) throw new LlmError("unavailable", "The Groq API returned an unreadable response.");
  const choice = b.choices?.[0];
  if (!choice) throw new LlmError("blocked", "Groq returned no answer.");

  const calls: LlmReply["calls"] = [];
  for (const [i, c] of (choice.message?.tool_calls ?? []).entries()) {
    const name = c.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const raw = c.function?.arguments;
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        throw new LlmError("bad_request", "The model produced a malformed tool call. Try again.");
      }
    } else if (raw && typeof raw === "object") {
      args = raw;
    }
    calls.push({ id: c.id ?? `call_${i + 1}`, name, args });
  }

  const text = choice.message?.content ?? "";
  if (!text && calls.length === 0 && choice.finish_reason && choice.finish_reason !== "stop") {
    throw new LlmError("blocked", `Groq stopped without an answer (${choice.finish_reason}).`);
  }
  return { text, calls };
}

async function toError(res: Response): Promise<LlmError> {
  const body = (await res.json().catch(() => undefined)) as
    { error?: { message?: string; code?: string } } | undefined;
  const detail = body?.error?.message?.slice(0, 300);
  switch (true) {
    case res.status === 429: {
      const header = Number(res.headers.get("retry-after"));
      // Groq's text says which limit (tokens per minute, requests per day, ...) and how long to wait.
      log("warn", "groq rate limited", {
        detail,
        retryAfterHeader: res.headers.get("retry-after"),
        remainingTokens: res.headers.get("x-ratelimit-remaining-tokens"),
      });
      return new LlmError(
        "rate_limited",
        "The Groq API rate limit or quota was reached. Try again later.",
        Number.isFinite(header) && header > 0 ? header * 1000 : retryHint(detail),
      );
    }
    case res.status === 401 || res.status === 403:
      return new LlmError("auth", "The Groq API rejected the gateway's API key.");
    // Groq's answer when the model emitted a tool call it could not parse.
    case res.status === 400 && body?.error?.code === "tool_use_failed":
      return new LlmError("bad_request", "The model produced a malformed tool call. Try again.");
    case res.status === 400 || res.status === 404:
      return new LlmError(
        "bad_request",
        `Groq rejected the request${detail ? `: ${detail}` : ""}.`,
      );
    default:
      return new LlmError(
        "unavailable",
        `The Groq API failed (HTTP ${res.status}). Try again shortly.`,
      );
  }
}

/** Groq's 429 text says "Please try again in 6.52s" (or "850ms", "1m3.5s") when no header is sent. */
export function retryHint(detail: string | undefined): number | undefined {
  const m = detail?.match(/try again in (?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i);
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  const minutes = Number(m[1] ?? 0);
  const rest =
    m[2] === undefined ? 0 : m[3]!.toLowerCase() === "ms" ? Number(m[2]) : Number(m[2]) * 1000;
  const ms = Math.ceil(minutes * 60_000 + rest);
  return ms > 0 ? ms : undefined;
}
