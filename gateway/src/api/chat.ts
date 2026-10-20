import express from "express";
import { z } from "zod";
import { principalOf } from "../auth/middleware.js";
import { FailureLimiter } from "../auth/rateLimit.js";
import { runAgent, type AgentLimits } from "../chat/agent.js";
import type { LlmClient } from "../chat/types.js";
import type { ToolSurface, SearchMode } from "../search/surface.js";
import { log } from "../logger.js";
import { HttpError, parse } from "./errors.js";

/** A model the user can pick for a chat. */
export interface ChatProvider {
  id: string;
  model: string;
  llm: LlmClient;
  /** Limits that suit this provider (a small tokens-per-minute cap wants smaller results). */
  limits?: Partial<AgentLimits>;
}

export interface ChatSetup {
  /** The model used unless the request names another of `providers`. */
  llm: LlmClient;
  /** Every selectable provider (omit for just `llm`) and which one is the default. */
  providers?: ChatProvider[];
  defaultProvider?: string;
  limits?: Partial<AgentLimits>;
  /** Turns one user may start per minute: each turn costs several LLM requests. */
  turnsPerMinute: number;
  /** Whether the model gets every tool or search_tools + call_tool; default off. */
  searchMode?: SearchMode;
  /**
   * Hold every tool that isn't marked read-only until the user approves it in the
   * dashboard (the turn ends with a `confirm` event); default off.
   */
  confirmWrites?: boolean;
  searchAutoThreshold?: number;
  now?: () => Date;
}

const bodySchema = z.object({
  /** Writes the user approved after a `confirm` event: each lets one identical call through. */
  approved: z
    .array(z.object({ name: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()) }))
    .max(10)
    .optional(),
  /** One of the ids from GET /api/meta `chatProviders`; omitted = the default. */
  provider: z.string().min(1).max(32).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(8_000),
      }),
    )
    .min(1)
    .max(40)
    .refine((m) => m.at(-1)?.role === "user", "the last message must be from the user"),
});

const HEARTBEAT_MS = 15_000;

/**
 * POST /api/chat: one chat turn as a Server-Sent Events stream. The caller
 * is whoever authenticated the request (session cookie or API key), and the
 * agent's tool calls go through the same ToolRouter as MCP clients (via a ToolSurface, which may swap the tool list for search_tools + call_tool), as that
 * user - so they're routed, time-limited and audited identically
 * (`source = chat`).
 */
export function chatApi(tools: ToolSurface, setup: ChatSetup | undefined) {
  const api = express.Router();
  // Counted per user and per pod (like the login limiter): enough to stop one
  // member burning the shared free-tier quota.
  const turns = new FailureLimiter({ max: setup?.turnsPerMinute ?? 1, windowMs: 60_000 });

  api.post("/", async (req, res) => {
    if (!setup) {
      throw new HttpError(503, "chat_not_configured", "The chat agent is not configured.");
    }
    const { messages, provider, approved } = parse(bodySchema, req.body);
    const principal = principalOf(res);
    let llm = setup.llm;
    let limits = setup.limits;
    // The default provider's own limits apply when none is named.
    const defaults = setup.providers?.find((p) => p.id === setup.defaultProvider);
    if (provider === undefined && defaults) limits = { ...limits, ...defaults.limits };
    if (provider !== undefined) {
      const chosen = setup.providers?.find((p) => p.id === provider);
      if (!chosen) {
        throw new HttpError(
          400,
          "unknown_provider",
          `Chat provider '${provider}' is not available.`,
        );
      }
      llm = chosen.llm;
      limits = { ...limits, ...chosen.limits };
    }

    const wait = turns.retryAfterMs(principal.userId);
    if (wait > 0) {
      res.set("Retry-After", String(Math.ceil(wait / 1000)));
      throw new HttpError(429, "rate_limited", "Too many chat messages. Wait a moment.");
    }
    turns.recordFailure(principal.userId);

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell nginx-style proxies not to hold the stream back.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const gone = new AbortController();
    res.on("close", () => gone.abort());
    // A comment line every so often keeps idle-timeout proxies from closing a long turn.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

    try {
      const events = runAgent(
        messages,
        {
          llm,
          limits,
          now: setup.now,
          approved,
          needsConfirmation: setup.confirmWrites
            ? async (name) => (await tools.isReadOnly(name)) === false
            : undefined,
          describeTool: async (name) => {
            const t = await tools.describeTool(name);
            return (
              t && {
                description: t.description,
                destructive: t.destructive,
                idempotent: t.idempotent,
              }
            );
          },
          listTools: () => tools.listTools(principal),
          callTool: (name, args) => tools.callTool({ principal, source: "chat" }, name, args),
        },
        gone.signal,
      );
      for await (const event of events) {
        if (gone.signal.aborted) break;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      // Headers are already out, so Express's error handler can't send JSON.
      log("error", "chat stream failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      const event = {
        type: "error",
        code: "internal",
        message: "The chat agent failed unexpectedly.",
      };
      res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  return api;
}
