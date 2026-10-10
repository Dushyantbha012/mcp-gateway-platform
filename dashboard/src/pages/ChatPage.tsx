import { Send, Square } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, errorMessage } from "@/api/client";
import { useMeta } from "@/api/hooks";
import type { ChatMessage } from "@/api/types";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { streamChat } from "@/lib/chatStream";
import { applyEvent, type ToolRun, type Turn } from "@/lib/chatTurns";

/** The transcript the gateway needs: finished text turns only, ending with the user's message. */
function toMessages(turns: Turn[]): ChatMessage[] {
  return turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text }));
}

function ToolRunItem({ run }: { run: ToolRun }) {
  const running = !run.result;
  return (
    <li className="rounded-md border bg-background text-xs">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
          <code className="font-medium">{run.name}</code>
          {running ? (
            <Badge variant="secondary">running…</Badge>
          ) : run.result!.isError ? (
            <Badge variant="destructive">failed</Badge>
          ) : (
            <Badge variant="secondary">ok</Badge>
          )}
          {run.result && <span className="text-muted-foreground">{run.result.durationMs} ms</span>}
        </summary>
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <div className="text-muted-foreground">Arguments</div>
            <pre className="overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(run.args, null, 2)}
            </pre>
          </div>
          {run.result && (
            <div>
              <div className="text-muted-foreground">Result</div>
              <pre className="overflow-x-auto whitespace-pre-wrap">{run.result.summary}</pre>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

function TurnView({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
          {turn.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {turn.tools.length > 0 && (
        <div className="w-full max-w-[85%]">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Tools called ({turn.tools.length})
          </div>
          <ul className="space-y-1" aria-label="Tools called">
            {turn.tools.map((run) => (
              <ToolRunItem key={run.id} run={run} />
            ))}
          </ul>
        </div>
      )}
      {turn.text && (
        <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
          {turn.text}
        </div>
      )}
      {streaming && !turn.text && turn.tools.every((t) => t.result) && (
        <div className="text-xs text-muted-foreground">Thinking…</div>
      )}
      {turn.stopped && <div className="text-xs text-muted-foreground">Stopped.</div>}
      {turn.error && (
        <div role="alert" className="max-w-[85%] text-sm text-destructive">
          {turn.error}
        </div>
      )}
    </div>
  );
}

export function ChatPage() {
  const meta = useMeta();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  const disabled = meta.data?.chatEnabled === false;

  async function send() {
    const text = input.trim();
    if (!text || streaming || disabled) return;
    const user: Turn = { id: nextId.current++, role: "user", text, tools: [] };
    const reply: Turn = { id: nextId.current++, role: "assistant", text: "", tools: [] };
    const history = toMessages([...turns, user]);
    setTurns((t) => [...t, user, reply]);
    setInput("");
    setStreaming(true);

    const ctrl = new AbortController();
    abort.current = ctrl;
    const update = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.id === reply.id ? fn(t) : t)));
    try {
      await streamChat(history, {
        signal: ctrl.signal,
        onEvent: (event) => update((t) => applyEvent(t, event)),
      });
    } catch (err) {
      if (ctrl.signal.aborted) update((t) => ({ ...t, stopped: true }));
      else
        update((t) => ({
          ...t,
          error:
            err instanceof ApiError && err.code === "chat_not_configured"
              ? "The chat agent isn't configured on this gateway."
              : errorMessage(err),
        }));
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <>
      <PageHeader
        title="Chat"
        description="Ask questions that are answered with the same tools your MCP client sees. Every tool call is made as you and appears in the audit log."
      />
      {disabled && (
        <Card className="mb-4">
          <CardContent className="py-4 text-sm" role="status">
            The chat agent is not configured on this gateway: an admin needs to set a Gemini API
            key.
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="space-y-4 py-4">
          <div
            className="min-h-48 space-y-4"
            aria-live="polite"
            aria-label="Conversation"
            role="log"
          >
            {turns.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Try “list the products in the store” or “what orders came in today?”.
              </p>
            )}
            {turns.map((turn, i) => (
              <TurnView key={turn.id} turn={turn} streaming={streaming && i === turns.length - 1} />
            ))}
            <div ref={bottom} />
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              aria-label="Message"
              placeholder="Ask something…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={8000}
              disabled={disabled}
              className="min-h-10"
            />
            {streaming ? (
              <Button variant="outline" onClick={() => abort.current?.abort()}>
                <Square /> Stop
              </Button>
            ) : (
              <Button onClick={() => void send()} disabled={disabled || !input.trim()}>
                <Send /> Send
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
