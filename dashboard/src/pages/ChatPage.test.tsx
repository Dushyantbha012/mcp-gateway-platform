import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage } from "@/api/types";
import { apiError, admin, loggedInAs, member, server } from "@/test/server";
import { renderApp } from "@/test/render";
import { applyEvent } from "@/lib/chatTurns";

const sse = (e: ChatEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** A response whose events the test releases one at a time. */
function controlledStream() {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
  return {
    response: () => new HttpResponse(body, { headers: { "Content-Type": "text/event-stream" } }),
    send: (e: ChatEvent) => ctrl.enqueue(enc.encode(sse(e))),
    raw: (s: string) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close(),
  };
}

const streamOf = (events: ChatEvent[]) =>
  new HttpResponse(events.map(sse).join(""), { headers: { "Content-Type": "text/event-stream" } });

const call: ChatEvent = {
  type: "tool_call",
  id: "c1",
  name: "woocommerce__list_orders",
  server: "woocommerce",
  args: { after: "2026-10-10" },
};
const result: ChatEvent = {
  type: "tool_result",
  id: "c1",
  name: "woocommerce__list_orders",
  isError: false,
  summary: '[{"id":24}]',
  durationMs: 42,
};

async function openChat(user = admin) {
  loggedInAs(user);
  const utils = renderApp("/chat");
  const box = await screen.findByLabelText("Message");
  return { ...utils, box };
}

describe("Chat page", () => {
  it("sends the message, shows the tools called and the answer", async () => {
    const bodies: { messages: ChatMessage[] }[] = [];
    server.use(
      http.post("/api/chat", async ({ request }) => {
        bodies.push((await request.json()) as { messages: ChatMessage[] });
        return streamOf([
          call,
          result,
          { type: "text", text: "One order: #24." },
          { type: "done", steps: 2 },
        ]);
      }),
    );
    const { user, box } = await openChat();
    await user.type(box, "what orders came in today?");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("One order: #24.")).toBeInTheDocument();
    expect(bodies[0].messages).toEqual([{ role: "user", text: "what orders came in today?" }]);
    const tools = screen.getByRole("list", { name: "Tools called" });
    expect(within(tools).getByText("woocommerce__list_orders")).toBeInTheDocument();
    expect(within(tools).getByText("ok")).toBeInTheDocument();
    expect(within(tools).getByText("42 ms")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("shows a tool as running until its result arrives, then the answer, live", async () => {
    const s = controlledStream();
    server.use(http.post("/api/chat", () => s.response()));
    const { user, box } = await openChat();
    await user.type(box, "orders");
    await user.keyboard("{Enter}");

    s.send(call);
    expect(await screen.findByText("running…")).toBeInTheDocument();
    s.send(result);
    expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("running…")).not.toBeInTheDocument();
    s.send({ type: "text", text: "Done." });
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    s.send({ type: "done", steps: 2 });
    s.end();
    await waitFor(() => expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument());
  });

  it("shows a failed tool, and sends the earlier turns with the next message", async () => {
    const bodies: { messages: ChatMessage[] }[] = [];
    let n = 0;
    server.use(
      http.post("/api/chat", async ({ request }) => {
        bodies.push((await request.json()) as { messages: ChatMessage[] });
        return n++ === 0
          ? streamOf([
              call,
              { ...result, isError: true, summary: "Order not found" },
              { type: "text", text: "No such order." },
              { type: "done", steps: 2 },
            ])
          : streamOf([
              { type: "text", text: "ok" },
              { type: "done", steps: 1 },
            ]);
      }),
    );
    const { user, box } = await openChat();
    await user.type(box, "first");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("failed")).toBeInTheDocument();
    await screen.findByText("No such order.");
    await user.type(box, "second");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].messages).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "No such order." },
      { role: "user", text: "second" },
    ]);
  });

  it("shows an error event from the agent", async () => {
    server.use(
      http.post("/api/chat", () =>
        streamOf([
          { type: "error", code: "rate_limited", message: "The Gemini quota was reached." },
        ]),
      ),
    );
    const { user, box } = await openChat();
    await user.type(box, "hi");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("The Gemini quota was reached.");
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it.each([
    [429, "rate_limited", "Too many chat messages. Wait a moment.", /too many chat messages/i],
    [503, "chat_not_configured", "The chat agent is not configured.", /isn't configured/i],
    [500, "internal", "Internal server error", /internal server error/i],
  ])("shows HTTP %i from the gateway", async (status, code, message, expected) => {
    server.use(http.post("/api/chat", () => apiError(status, code, message)));
    const { user, box } = await openChat();
    await user.type(box, "hi");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  it("goes back to login when the session has expired", async () => {
    server.use(http.post("/api/chat", () => apiError(401, "unauthorized", "Sign in")));
    const { user, box } = await openChat();
    await user.type(box, "hi");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/login/));
  });

  it("Stop aborts the request and re-enables sending", async () => {
    const s = controlledStream();
    let aborted = false;
    server.use(
      http.post("/api/chat", ({ request }) => {
        request.signal.addEventListener("abort", () => (aborted = true));
        return s.response();
      }),
    );
    const { user, box } = await openChat();
    await user.type(box, "slow one");
    await user.keyboard("{Enter}");
    s.send(call);
    await user.click(await screen.findByRole("button", { name: /stop/i }));

    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
    await waitFor(() => expect(aborted).toBe(true));
  });

  it("keeps Shift+Enter for new lines and doesn't send empty messages", async () => {
    let posts = 0;
    server.use(http.post("/api/chat", () => (posts++, streamOf([{ type: "done", steps: 1 }]))));
    const { user, box } = await openChat();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box).toHaveValue("line one\nline two");
    expect(posts).toBe(0);
  });

  it("is switched off, with an explanation, when the gateway has no model configured", async () => {
    loggedInAs(admin);
    server.use(
      http.get("/api/meta", () => HttpResponse.json({ mcpUrl: null, chatEnabled: false })),
    );
    renderApp("/chat");
    expect(await screen.findByRole("status")).toHaveTextContent(/not configured/i);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("renders the answer as markdown", async () => {
    server.use(
      http.post("/api/chat", () =>
        streamOf([
          { type: "text", text: "Found **2 orders**:\n\n- #34 processing\n- #24 processing" },
          { type: "done", steps: 1 },
        ]),
      ),
    );
    const { user, box } = await openChat();
    await user.type(box, "orders");
    await user.keyboard("{Enter}");
    expect((await screen.findByText("2 orders")).tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("starts from suggestions: one sends at once, the create prompt fills the box", async () => {
    const bodies: { messages: ChatMessage[] }[] = [];
    server.use(
      http.post("/api/chat", async ({ request }) => {
        bodies.push((await request.json()) as { messages: ChatMessage[] });
        return streamOf([
          { type: "text", text: "ok" },
          { type: "done", steps: 1 },
        ]);
      }),
    );
    const { user, box } = await openChat();
    await user.click(screen.getByRole("button", { name: /create a product named/i }));
    expect(box).toHaveValue('Create a product named "" priced ');
    expect(bodies).toHaveLength(0);
    await user.clear(box);
    await user.click(screen.getByRole("button", { name: "What orders came in today?" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].messages).toEqual([{ role: "user", text: "What orders came in today?" }]);
  });

  it("New chat clears the conversation, and is disabled while a turn streams", async () => {
    const s = controlledStream();
    server.use(http.post("/api/chat", () => s.response()));
    const { user, box } = await openChat();
    expect(screen.getByRole("button", { name: /new chat/i })).toBeDisabled();
    await user.type(box, "hello");
    await user.keyboard("{Enter}");
    await screen.findByText("Thinking…");
    expect(screen.getByRole("button", { name: /new chat/i })).toBeDisabled();
    s.send({ type: "text", text: "Hi there" });
    s.send({ type: "done", steps: 1 });
    s.end();
    await screen.findByText("Hi there");
    await waitFor(() => expect(screen.getByRole("button", { name: /new chat/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    expect(screen.queryByText("Hi there")).not.toBeInTheDocument();
    expect(screen.getByText("Ask your tools anything")).toBeInTheDocument();
  });

  it("is available to members, in the navigation", async () => {
    await openChat(member);
    expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument();
  });

  it("ignores a malformed event instead of ending the turn", async () => {
    const s = controlledStream();
    server.use(http.post("/api/chat", () => s.response()));
    const { user, box } = await openChat();
    await user.type(box, "hi");
    await user.keyboard("{Enter}");
    s.raw("event: text\ndata: {not json\n\n");
    s.send({ type: "text", text: "still here" });
    expect(await screen.findByText("still here")).toBeInTheDocument();
    s.end();
  });
});

describe("applyEvent", () => {
  const empty = { id: 1, role: "assistant" as const, text: "", tools: [] };
  it("accumulates text, tool calls and results in order", () => {
    let t = applyEvent(empty, { type: "text", text: "a" });
    t = applyEvent(t, { type: "text", text: "b" });
    t = applyEvent(t, call);
    t = applyEvent(t, result);
    expect(t.text).toBe("a\n\nb");
    expect(t.tools).toEqual([
      {
        id: "c1",
        name: "woocommerce__list_orders",
        args: { after: "2026-10-10" },
        result: { isError: false, summary: '[{"id":24}]', durationMs: 42 },
      },
    ]);
  });
  it("matches results to calls by id, not position", () => {
    let t = applyEvent(empty, call);
    t = applyEvent(t, { ...call, id: "c2" });
    t = applyEvent(t, { ...result, id: "c2" });
    expect(t.tools.map((x) => x.result !== undefined)).toEqual([false, true]);
  });
});
