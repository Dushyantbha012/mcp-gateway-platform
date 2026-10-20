import {
  Bot,
  ChevronRight,
  ShieldQuestion,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Plus,
  Send,
  Square,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, errorMessage } from "@/api/client";
import { useMeta } from "@/api/hooks";
import type { ChatMessage } from "@/api/types";
import { Markdown } from "@/components/Markdown";
import { NativeSelect } from "@/components/NativeSelect";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { streamChat } from "@/lib/chatStream";
import { applyEvent, type ToolRun, type Turn } from "@/lib/chatTurns";
import { cn } from "@/lib/utils";

/** Starter prompts for an empty conversation; `send: false` fills the box instead. */
const SUGGESTIONS = [
  { text: "List the products in the store", send: true },
  { text: "What orders came in today?", send: true },
  { text: 'Create a product named "" priced ', send: false },
];

const PROVIDER_LABEL: Record<string, string> = { groq: "Groq", gemini: "Gemini" };

/** The transcript the gateway needs: finished text turns only, ending with the user's message. */
function toMessages(turns: Turn[]): ChatMessage[] {
  return turns
    .filter((t) => t.text.trim())
    .map((t) => ({ role: t.role, text: t.modelText ?? t.text }));
}

function ToolRunItem({ run }: { run: ToolRun }) {
  const running = !run.result;
  const failed = run.result?.isError === true;
  return (
    <li className="rounded-lg border bg-background text-xs">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          {running ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : failed ? (
            <CircleX className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <CircleCheck className="size-3.5 shrink-0 text-success" />
          )}
          <code className="min-w-0 truncate font-medium">{run.name}</code>
          <span
            className={cn(
              "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              failed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
            )}
          >
            {running ? "running…" : failed ? "failed" : "ok"}
          </span>
          {run.result && (
            <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
              {run.result.durationMs} ms
            </span>
          )}
        </summary>
        <div className="space-y-3 border-t px-3 py-3">
          <div>
            <div className="mb-1 font-medium text-muted-foreground">Arguments</div>
            <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono whitespace-pre-wrap">
              {JSON.stringify(run.args, null, 2)}
            </pre>
          </div>
          {run.result && (
            <div>
              <div className="mb-1 font-medium text-muted-foreground">Result</div>
              <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono whitespace-pre-wrap">
                {run.result.summary}
              </pre>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

function ConfirmCard({
  turn,
  actionable,
  onDecide,
}: {
  turn: Turn;
  actionable: boolean;
  onDecide: (approve: boolean) => void;
}) {
  const items = turn.confirmations ?? [];
  return (
    <section
      aria-label="Approval needed"
      className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
    >
      <div className="flex items-center gap-2 font-medium">
        <ShieldQuestion className="size-4 text-amber-600" />
        {items.length === 1
          ? "This changes data. Run it?"
          : `${items.length} actions change data. Run them?`}
      </div>
      <ul className="space-y-2">
        {items.map((c) => (
          <li key={c.id} className="rounded-md border bg-background p-2 text-xs">
            <code className="font-medium">{c.name}</code>
            <pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(c.args, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
      {turn.decision ? (
        <div className="text-xs text-muted-foreground">
          {turn.decision === "approved" ? "Approved." : "Declined."}
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={!actionable} onClick={() => onDecide(true)}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!actionable}
            onClick={() => onDecide(false)}
          >
            Decline
          </Button>
        </div>
      )}
    </section>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      Thinking…
    </div>
  );
}

function TurnView({
  turn,
  streaming,
  actionable,
  onDecide,
}: {
  turn: Turn;
  streaming: boolean;
  actionable: boolean;
  onDecide: (approve: boolean) => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm shadow-sm leading-relaxed whitespace-pre-wrap text-primary-foreground sm:max-w-[75%]">
          {turn.text}
        </div>
      </div>
    );
  }
  const idle = streaming && !turn.text && turn.tools.every((t) => t.result);
  return (
    <div className="flex gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-2 text-primary-foreground shadow-sm">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-3 pt-1">
        {turn.tools.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Wrench className="size-3" /> Tools called ({turn.tools.length})
            </div>
            <ul className="space-y-1.5" aria-label="Tools called">
              {turn.tools.map((run) => (
                <ToolRunItem key={run.id} run={run} />
              ))}
            </ul>
          </div>
        )}
        {turn.text && <Markdown>{turn.text}</Markdown>}
        {turn.confirmations && turn.confirmations.length > 0 && (
          <ConfirmCard turn={turn} actionable={actionable} onDecide={onDecide} />
        )}
        {idle && <ThinkingDots />}
        {turn.stopped && <div className="text-xs text-muted-foreground">Stopped.</div>}
        {turn.error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {turn.error}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (s: (typeof SUGGESTIONS)[number]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border bg-background">
        <Bot className="size-6" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">Ask your tools anything</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          The assistant uses the same tools your MCP client sees, acts as you, and every call lands
          in the audit log.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="rounded-full border bg-background px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {s.text.replace(/ ""/, " …").replace(/ priced $/, " priced …")}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatPage() {
  const meta = useMeta();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState(
    () => new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const [streaming, setStreaming] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Follow the answer as it streams, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || turns.at(-1)?.role === "user") el.scrollTop = el.scrollHeight;
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  const disabled = meta.data?.chatEnabled === false;
  // The user's pick, if any; otherwise the gateway's default.
  const providers = meta.data?.chatProviders ?? [];
  const [pickedProvider, setPickedProvider] = useState<string | undefined>(undefined);
  const provider =
    providers.find((p) => p.id === pickedProvider)?.id ?? meta.data?.chatProvider ?? undefined;

  /** The user's answer to the writes the last turn is holding: approve them all, or decline. */
  function decide(approve: boolean) {
    const held = turns.at(-1)?.confirmations ?? [];
    if (held.length === 0 || streaming) return;
    const names = held.map((c) => c.name).join(", ");
    setTurns((all) =>
      all.map((t, i) =>
        i === all.length - 1 ? { ...t, decision: approve ? "approved" : "denied" } : t,
      ),
    );
    if (!approve) {
      void send(`No, don't run ${names}.`);
      return;
    }
    void send(`Approved: ${names}`, {
      modelText: `Yes, go ahead: ${held.map((c) => `${c.name} with ${JSON.stringify(c.args)}`).join("; ")}.`,
      approved: held.map((c) => ({ name: c.name, args: c.args })),
    });
  }

  async function send(
    override?: string,
    approval?: { modelText: string; approved: { name: string; args: unknown }[] },
  ) {
    const text = (override ?? input).trim();
    if (!text || streaming || disabled) return;
    const user: Turn = {
      id: nextId.current++,
      role: "user",
      text,
      modelText: approval?.modelText,
      tools: [],
    };
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
        provider,
        approved: approval?.approved,
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
      box.current?.focus();
    }
  }

  function pick(s: (typeof SUGGESTIONS)[number]) {
    if (s.send) void send(s.text);
    else {
      setInput(s.text);
      box.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <>
      <PageHeader
        title="Chat"
        description="Answers come from the same tools your MCP client sees. Every call is made as you and appears in the audit log."
        actions={
          <div className="flex items-center gap-2">
            {providers.length > 1 && (
              <NativeSelect
                aria-label="Model"
                className="w-auto"
                value={provider ?? ""}
                disabled={streaming}
                onChange={(e) => setPickedProvider(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PROVIDER_LABEL[p.id] ?? p.id} · {p.model}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={streaming || turns.length === 0}
              onClick={() => setTurns([])}
            >
              <Plus /> New chat
            </Button>
          </div>
        }
      />
      {disabled && (
        <div
          role="status"
          className="mb-4 rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground"
        >
          The chat agent is not configured on this gateway: an admin needs to set a Groq or Gemini
          API key.
        </div>
      )}
      <section
        aria-label="Chat"
        className="flex h-[calc(100svh-17rem)] min-h-[24rem] sm:h-[calc(100svh-13rem)] flex-col overflow-hidden rounded-2xl border bg-card shadow-sm"
      >
        <div
          ref={scroller}
          className="flex-1 overflow-y-auto px-4 py-6"
          aria-live="polite"
          aria-label="Conversation"
          role="log"
        >
          <div className="mx-auto h-full max-w-3xl space-y-6">
            {turns.length === 0 ? (
              <EmptyState onPick={pick} disabled={disabled} />
            ) : (
              turns.map((turn, i) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  streaming={streaming && i === turns.length - 1}
                  actionable={!streaming && i === turns.length - 1}
                  onDecide={decide}
                />
              ))
            )}
          </div>
        </div>
        <div className="border-t bg-background/60 px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-3 focus-within:ring-ring/40">
              <Textarea
                ref={box}
                aria-label="Message"
                placeholder="Ask something…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={8000}
                disabled={disabled}
                rows={1}
                className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
              {streaming ? (
                <Button variant="outline" size="sm" onClick={() => abort.current?.abort()}>
                  <Square /> Stop
                </Button>
              ) : (
                <Button size="sm" onClick={() => void send()} disabled={disabled || !input.trim()}>
                  <Send /> Send
                </Button>
              )}
            </div>
            <p className="mt-1.5 px-1 text-xs text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
