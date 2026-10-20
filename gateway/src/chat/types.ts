import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** What the dashboard sends: plain text turns only. Tool calls aren't replayed. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** A write the user has approved in the dashboard: that tool, with exactly these arguments, once. */
export interface ApprovedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Opaque token Gemini 3 attaches to a call and expects back with it. */
  signature?: string;
}

export interface ToolOutput {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

/** The conversation as the model sees it, independent of any vendor's wire format. */
export type Turn =
  | { role: "user"; text: string }
  | { role: "model"; text: string; calls: ToolCall[] }
  | { role: "tool"; results: ToolOutput[] };

export interface LlmRequest {
  system: string;
  turns: Turn[];
  tools: Tool[];
  signal?: AbortSignal;
}

export interface LlmReply {
  text: string;
  calls: ToolCall[];
}

/** The only thing the agent loop knows about a model. */
export interface LlmClient {
  generate(req: LlmRequest): Promise<LlmReply>;
}

export type LlmErrorKind = "rate_limited" | "unavailable" | "blocked" | "auth" | "bad_request";

/** A model failure with a message that is safe to show the user. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Events streamed to the browser, one SSE message each. */
export type ChatEvent =
  | { type: "tool_call"; id: string; name: string; server: string | null; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      isError: boolean;
      summary: string;
      durationMs: number;
    }
  /** A write tool the model wants to run: held until the user approves it (the turn ends here). */
  | {
      type: "confirm";
      id: string;
      name: string;
      server: string | null;
      args: unknown;
      /** What the upstream says the tool does, so the user judges it and not just the arguments. */
      info?: { description: string; destructive?: boolean; idempotent?: boolean };
    }
  | { type: "text"; text: string }
  | { type: "done"; steps: number }
  | { type: "error"; code: string; message: string };
