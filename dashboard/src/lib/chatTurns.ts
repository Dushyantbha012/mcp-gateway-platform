import type { ChatEvent, ToolHints } from "@/api/types";

export interface ToolRun {
  id: string;
  name: string;
  args: unknown;
  /** Undefined while the call is still running. */
  result?: { isError: boolean; summary: string; durationMs: number };
}

/** A write the assistant wants to run and the user has yet to approve. */
export interface Confirmation {
  id: string;
  name: string;
  args: unknown;
  info?: ToolHints;
}

export interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** What the model is sent instead of `text`, when they differ (e.g. an approval with its arguments). */
  modelText?: string;
  tools: ToolRun[];
  /** Writes waiting for the user; `decision` is set once they answered. */
  confirmations?: Confirmation[];
  decision?: "approved" | "denied";
  error?: string;
  stopped?: boolean;
}

/** Applies one streamed event to the assistant turn it belongs to. */
export function applyEvent(turn: Turn, event: ChatEvent): Turn {
  switch (event.type) {
    case "text":
      return { ...turn, text: turn.text ? `${turn.text}\n\n${event.text}` : event.text };
    case "tool_call":
      return {
        ...turn,
        tools: [...turn.tools, { id: event.id, name: event.name, args: event.args }],
      };
    case "tool_result":
      return {
        ...turn,
        tools: turn.tools.map((t) =>
          t.id === event.id
            ? {
                ...t,
                result: {
                  isError: event.isError,
                  summary: event.summary,
                  durationMs: event.durationMs,
                },
              }
            : t,
        ),
      };
    case "confirm":
      return {
        ...turn,
        confirmations: [
          ...(turn.confirmations ?? []),
          { id: event.id, name: event.name, args: event.args, info: event.info },
        ],
      };
    case "error":
      return { ...turn, error: event.message };
    case "done":
      return turn;
  }
}
