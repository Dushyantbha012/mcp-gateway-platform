import { ApiError, reportUnauthorized } from "@/api/client";
import type { ChatEvent, ChatMessage } from "@/api/types";
import { SseParser } from "@/lib/sse";

/**
 * Sends one chat turn and calls `onEvent` for each event as it arrives.
 * Resolves when the stream ends; rejects with an ApiError for an HTTP error
 * (not logged in, chat not configured, rate limited), and with an AbortError
 * if `signal` is aborted. Plain fetch, not EventSource: this is a POST.
 */
export async function streamChat(
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; onEvent: (event: ChatEvent) => void },
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ messages }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => undefined);
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    if (res.status === 401) reportUnauthorized();
    throw new ApiError(
      res.status,
      err?.code ?? "http_error",
      err?.message ?? `Request failed (HTTP ${res.status})`,
    );
  }
  if (!res.body) throw new ApiError(502, "no_stream", "The gateway sent no response stream.");

  const parser = new SseParser();
  const reader = res.body.getReader();
  // Browsers reject a pending read when the request is aborted; cancelling
  // the reader ourselves makes that explicit (and the same everywhere).
  const cancel = () => void reader.cancel().catch(() => {});
  opts.signal?.addEventListener("abort", cancel, { once: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(value)) {
      try {
        opts.onEvent(JSON.parse(message.data) as ChatEvent);
      } catch (e) {
        if (e instanceof SyntaxError) continue; // a malformed event shouldn't end the turn
        throw e;
      }
    }
  }
  opts.signal?.removeEventListener("abort", cancel);
  if (opts.signal?.aborted) throw new DOMException("The turn was stopped.", "AbortError");
}
