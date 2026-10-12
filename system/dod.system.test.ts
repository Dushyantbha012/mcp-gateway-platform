import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The brief's definition of done, scripted end to end against the live
 * deployment (k3d locally, the VPS later): store checkout, chat as user A,
 * an external MCP client as user B, a prompt across two upstreams, revoke,
 * disable, kill an upstream, and an audit log that accounts for every call.
 *
 * Steps share state and run in order. Skipped unless the SYSTEM_* env is set;
 * scripts/verify-phase6.sh sets it from the cluster's Secrets.
 */
const env = {
  gateway: process.env.SYSTEM_GATEWAY_URL,
  dashboard: process.env.SYSTEM_DASHBOARD_URL,
  store: process.env.SYSTEM_STORE_URL,
  adminKey: process.env.SYSTEM_ADMIN_KEY,
  storeUser: process.env.SYSTEM_STORE_ADMIN_USER,
  storePassword: process.env.SYSTEM_STORE_ADMIN_PASSWORD,
  namespace: process.env.NAMESPACE ?? "urumi",
  wooDeployment: process.env.MCP_DEPLOYMENT ?? "platform-store-woocommerce-mcp",
};
const enabled = Object.entries(env).every(([, v]) => Boolean(v));

type Outcome = "success" | "tool_error" | "timeout" | "unreachable" | "rejected" | "denied";
type Source = "mcp" | "chat";
interface Expected {
  tool: string;
  source: Source;
  outcome: Outcome;
}
interface Person {
  id: string;
  email: string;
  keyId: string;
  key: string;
  expected: Expected[];
  cookie?: string;
}
interface ChatEvent {
  type: string;
  name?: string;
  isError?: boolean;
  text?: string;
  message?: string;
  summary?: string;
}

describe.skipIf(!enabled)("system: the definition of done", () => {
  const run = Date.now().toString(36);
  const clients: Client[] = [];
  const outDir = mkdtempSync(join(tmpdir(), "dod-"));
  let a: Person;
  let b: Person;
  let productName: string;
  let orderId: number;
  let deepwikiId: string;
  let wooId: string;

  // ---- helpers -----------------------------------------------------------

  async function api(path: string, init: RequestInit & { key?: string } = {}) {
    const res = await fetch(`${env.gateway}/api${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${init.key ?? env.adminKey}`,
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
  const post = (path: string, data: unknown, key?: string) =>
    api(path, { method: "POST", body: JSON.stringify(data), key });
  const patch = (path: string, data: unknown) =>
    api(path, { method: "PATCH", body: JSON.stringify(data) });

  async function connect(key: string) {
    const client = new Client({ name: "dod-suite", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${env.gateway}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  }
  const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

  /** Calls through the SDK client and records what the audit log must say. */
  async function call(
    p: Person,
    c: Client,
    name: string,
    args: Record<string, unknown>,
    outcome: Outcome,
  ) {
    const res = (await c.callTool({ name, arguments: args })) as CallToolResult;
    expect(Boolean(res.isError), `${name} isError`).toBe(outcome !== "success");
    p.expected.push({ tool: name, source: "mcp", outcome });
    return res;
  }
  const textOf = (r: CallToolResult) =>
    r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  async function createPerson(label: string): Promise<Person> {
    const email = `dod-${label}-${run}@example.com`;
    const invited = await post("/users", { email, name: `DoD ${label.toUpperCase()}` });
    expect(invited.status).toBe(201);
    const token = String(invited.body.inviteUrl).split("/").pop();
    const password = `pw-${run}-${label}-${Math.random().toString(36).slice(2)}`;
    const accepted = await fetch(`${env.dashboard}/api/auth/invites/${token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.dashboard! },
      body: JSON.stringify({ password }),
    });
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const id = (await accepted.json()).id as string;
    const key = await post(`/users/${id}/keys`, { name: "dod" });
    expect(key.status).toBe(201);
    return { id, email, keyId: key.body.id, key: key.body.key, expected: [], cookie };
  }

  /** One chat turn as the logged-in user (cookie session, like the dashboard). */
  async function chat(p: Person, message: string): Promise<ChatEvent[]> {
    const res = await fetch(`${env.dashboard}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Cookie: p.cookie!,
        Origin: env.dashboard!,
      },
      body: JSON.stringify({ messages: [{ role: "user", text: message }] }),
    });
    expect(res.status).toBe(200);
    const events: ChatEvent[] = [];
    for (const line of (await res.text()).split("\n")) {
      if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
    }
    return events;
  }
  const called = (events: ChatEvent[]) =>
    events.filter((e) => e.type === "tool_call").map((e) => e.name!);

  /**
   * The model decides what to call, so a turn that doesn't call the expected
   * tool is retried once. Every call the model made (in every attempt) is
   * recorded, because each one lands in the audit log.
   */
  async function chatUntil(p: Person, message: string, ok: (e: ChatEvent[]) => boolean) {
    let last: ChatEvent[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await chat(p, message);
      const results = last.filter((e) => e.type === "tool_result");
      for (const r of results) {
        p.expected.push({
          tool: r.name!,
          source: "chat",
          outcome: r.isError ? "tool_error" : "success",
        });
      }
      const err = last.find((e) => e.type === "error");
      expect(err, `chat error: ${JSON.stringify(err)}`).toBeUndefined();
      if (ok(last)) return last;
    }
    throw new Error(`chat never did what was asked:\n${JSON.stringify(last, null, 1)}`);
  }

  async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 75_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const serverStatus = async (slug: string) =>
    ((await api("/servers")).body as { slug: string; status: string }[]).find(
      (s) => s.slug === slug,
    )?.status;
  const waitStatus = (slug: string, want: string) =>
    waitFor(`${slug} to be ${want}`, async () =>
      (await serverStatus(slug)) === want ? true : undefined,
    );

  const kubectl = (...args: string[]) =>
    execFileSync("kubectl", ["-n", env.namespace, ...args], { stdio: "pipe" });

  async function storefrontProduct(name: string) {
    const res = await fetch(
      `${env.store}/wp-json/wc/store/v1/products?search=${encodeURIComponent(name)}`,
    );
    const products = (await res.json()) as {
      name: string;
      permalink: string;
      prices: { price: string };
    }[];
    return products.find((p) => p.name === name);
  }

  beforeAll(async () => {
    const servers = (await api("/servers")).body as { id: string; slug: string }[];
    wooId = servers.find((s) => s.slug === "woocommerce")!.id;
    deepwikiId = servers.find((s) => s.slug === "deepwiki")!.id;
    // A previous interrupted run may have left servers disabled or scaled down.
    for (const id of [wooId, deepwikiId]) await patch(`/servers/${id}`, { enabled: true });
    kubectl("scale", `deployment/${env.wooDeployment}`, "--replicas=1");
    await waitStatus("woocommerce", "connected");
    await waitStatus("deepwiki", "connected");
    a = await createPerson("a");
    b = await createPerson("b");
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    for (const id of [wooId, deepwikiId]) await patch(`/servers/${id}`, { enabled: true });
    kubectl("scale", `deployment/${env.wooDeployment}`, "--replicas=1");
    for (const p of [a, b]) if (p) await patch(`/users/${p.id}`, { disabled: true });
  });

  // ---- the scenario ------------------------------------------------------

  it("three upstreams are connected: woocommerce, deepwiki, github", async () => {
    for (const slug of ["woocommerce", "deepwiki", "github"]) {
      expect(await serverStatus(slug), slug).toBe("connected");
    }
  });

  it("Chat as user A: 'create a product' puts it on the storefront", async () => {
    productName = `DoD Mug ${run}`;
    await chatUntil(a, `Create a product named "${productName}" priced 9.75`, (ev) =>
      called(ev).includes("woocommerce__create_product"),
    );
    const product = await storefrontProduct(productName);
    expect(product, "product on the storefront").toBeDefined();
    expect(product!.prices.price).toBe("975");
    process.env.DOD_PRODUCT_PATH = new URL(product!.permalink).pathname;
  });

  it("Store: checkout with Cash on Delivery, visible in WooCommerce admin", () => {
    const orderFile = join(outDir, "order.json");
    execFileSync("npm", ["run", "test:live", "-w", "e2e", "--", "storefront"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "pipe",
      env: {
        ...process.env,
        STORE_URL: env.store,
        STORE_ADMIN_USER: env.storeUser,
        STORE_ADMIN_PASSWORD: env.storePassword,
        STOREFRONT_PRODUCT: process.env.DOD_PRODUCT_PATH,
        ORDER_OUT: orderFile,
      },
    });
    orderId = JSON.parse(readFileSync(orderFile, "utf8")).orderId;
    expect(orderId).toBeGreaterThan(0);
  });

  it("Chat as user A: 'what orders came in today?' returns that order", async () => {
    const events = await chatUntil(
      a,
      "What orders came in today? Give the order numbers.",
      (ev) =>
        called(ev).includes("woocommerce__list_orders") &&
        ev.some((e) => e.type === "text" && e.text!.includes(String(orderId))),
    );
    expect(called(events)).toContain("woocommerce__list_orders");
  });

  it("External client as user B: URL + key only, sees every server's tools, asks the orders question", async () => {
    const client = await connect(b.key);
    const names = await toolNames(client);
    for (const prefix of ["woocommerce__", "github__", "deepwiki__"]) {
      expect(
        names.some((n) => n.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    const orders = await call(b, client, "woocommerce__list_orders", {}, "success");
    expect(textOf(orders)).toContain(String(orderId));

    // B never sees an upstream URL, credential or admin surface.
    expect(JSON.stringify(await api("/servers", { key: b.key }))).not.toMatch(
      /api\.githubcopilot|mcp\.deepwiki|github_pat_|"url"/,
    );
    expect((await api("/users", { key: b.key })).status).toBe(403);
    expect((await api("/audit", { key: b.key })).status).toBe(403);
  });

  it("One session, tools from two upstreams (WooCommerce + DeepWiki, and GitHub)", async () => {
    const client = await connect(b.key);
    const products = await call(b, client, "woocommerce__list_products", {}, "success");
    expect(textOf(products)).toContain(productName);
    const wiki = await call(
      b,
      client,
      "deepwiki__read_wiki_structure",
      { repoName: "woocommerce/woocommerce" },
      "success",
    );
    expect(textOf(wiki)).toMatch(/WooCommerce/i);
    const me = await call(b, client, "github__get_me", {}, "success");
    expect(textOf(me)).toContain("login");
  });

  it("Chat agent: one prompt that needs two upstreams", async () => {
    const events = await chatUntil(
      a,
      "Use DeepWiki to look up the structure of the woocommerce/woocommerce repository, " +
        "and also list the products in my store. Mention one thing from each.",
      (ev) => {
        const names = called(ev);
        return (
          names.some((n) => n.startsWith("deepwiki__")) &&
          names.some((n) => n.startsWith("woocommerce__"))
        );
      },
    );
    expect(events.at(-1)?.type).toBe("done");
  });

  it("Tool permissions: a tool denied to members disappears for them and is refused if called, admins keep it", async () => {
    const hidden = "woocommerce__update_order_status";
    const rule = await api("/permissions", {
      method: "PUT",
      body: JSON.stringify({
        role: "member",
        serverSlug: "woocommerce",
        toolName: "update_order_status",
        effect: "deny",
      }),
    });
    expect(rule.status).toBe(200);
    try {
      // User B's external client: hidden from tools/list, the rest of the server intact.
      const client = await connect(b.key);
      const names = await toolNames(client);
      expect(names).not.toContain(hidden);
      expect(names).toContain("woocommerce__list_orders");

      // A client still holding the old list is refused, and it is audited as denied.
      const refused = await call(b, client, hidden, { id: orderId, status: "completed" }, "denied");
      expect(textOf(refused)).toContain("don't have permission");

      // The chat agent is given exactly the same view, as user A.
      const chatView = (await api("/tools", { key: a.key })).body as { name: string }[];
      expect(chatView.map((t) => t.name)).not.toContain(hidden);
      expect(chatView.map((t) => t.name)).toContain("woocommerce__list_orders");

      // Admins are not restricted.
      const adminView = (await api("/tools")).body as { name: string }[];
      expect(adminView.map((t) => t.name)).toContain(hidden);
    } finally {
      await api(`/permissions/${rule.body.id}`, { method: "DELETE" });
    }
    // Removing the rule brings the tool back on the very next list.
    expect(await toolNames(await connect(b.key))).toContain(hidden);
  });

  it("Revoke user B's key: the next call is rejected", async () => {
    const client = await connect(b.key);
    await toolNames(client);
    expect((await api(`/keys/${b.keyId}`, { method: "DELETE" })).status).toBe(200);
    for (const attempt of [
      () => client.callTool({ name: "woocommerce__list_orders", arguments: {} }),
      () => client.listTools(),
      () => connect(b.key),
    ]) {
      const err = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StreamableHTTPError);
      expect((err as StreamableHTTPError).code).toBe(401);
    }
  });

  it("Disable an upstream: its tools disappear from chat and from the external client", async () => {
    const stale = await connect(a.key);
    expect((await toolNames(stale)).some((n) => n.startsWith("deepwiki__"))).toBe(true);

    expect((await patch(`/servers/${deepwikiId}`, { enabled: false })).status).toBe(200);
    const chatView = (await api("/tools", { key: a.key })).body as { name: string }[];
    expect(chatView.some((t) => t.name.startsWith("deepwiki__"))).toBe(false);
    expect(chatView.some((t) => t.name.startsWith("woocommerce__"))).toBe(true);

    const fresh = await connect(a.key);
    const names = await toolNames(fresh);
    expect(names.some((n) => n.startsWith("deepwiki__"))).toBe(false);
    expect(names.some((n) => n.startsWith("github__"))).toBe(true);

    // A client holding the old list is refused, and it's audited as rejected.
    await call(a, stale, "deepwiki__read_wiki_structure", { repoName: "a/b" }, "rejected");

    // Chat can't use it either: the model is offered no deepwiki tools.
    const events = await chat(a, "Use DeepWiki to read the structure of woocommerce/woocommerce.");
    for (const r of events.filter((e) => e.type === "tool_result")) {
      a.expected.push({
        tool: r.name!,
        source: "chat",
        outcome: r.isError ? "tool_error" : "success",
      });
    }
    expect(called(events).some((n) => n.startsWith("deepwiki__"))).toBe(false);

    await patch(`/servers/${deepwikiId}`, { enabled: true });
    await waitStatus("deepwiki", "connected");
    const back = await toolNames(await connect(a.key));
    expect(back.some((n) => n.startsWith("deepwiki__"))).toBe(true);
  });

  it("Kill an upstream: the others keep working, the dashboard shows it unreachable", async () => {
    const client = await connect(a.key);
    try {
      kubectl("scale", `deployment/${env.wooDeployment}`, "--replicas=0");
      await waitStatus("woocommerce", "unreachable");
      const woo = ((await api("/servers")).body as { slug: string; lastError: string }[]).find(
        (s) => s.slug === "woocommerce",
      )!;
      expect(woo.lastError).toBeTruthy();

      await call(a, client, "github__get_me", {}, "success");
      await call(
        a,
        client,
        "deepwiki__read_wiki_structure",
        { repoName: "woocommerce/woocommerce" },
        "success",
      );
      const dead = await call(a, client, "woocommerce__list_orders", {}, "unreachable");
      expect(textOf(dead)).toMatch(/woocommerce/i);
      expect(await serverStatus("deepwiki")).toBe("connected");
      expect(await serverStatus("github")).toBe("connected");
    } finally {
      kubectl("scale", `deployment/${env.wooDeployment}`, "--replicas=1");
    }
    kubectl("rollout", "status", `deployment/${env.wooDeployment}`, "--timeout=120s");
    await waitStatus("woocommerce", "connected");
    await call(a, client, "woocommerce__list_orders", {}, "success");
  });

  it("Audit: every call above is in the log, once, under the right user and source", async () => {
    for (const p of [a, b]) {
      const rows = (await api(`/audit?userId=${p.id}&limit=500`)).body as {
        userEmail: string;
        tool: string;
        source: Source;
        outcome: Outcome;
        durationMs: number;
        server: string | null;
        ts: string;
      }[];
      const key = (r: Expected) => `${r.source} ${r.tool} ${r.outcome}`;
      const got = rows.map(key).sort();
      const want = p.expected.map(key).sort();
      expect(got, `audit rows for ${p.email}`).toEqual(want);
      for (const r of rows) {
        expect(r.userEmail).toBe(p.email);
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
        expect(Date.parse(r.ts)).toBeGreaterThan(Date.now() - 60 * 60 * 1000);
        expect(r.server === null || r.tool.startsWith(`${r.server}__`)).toBe(true);
      }
    }
    // Nothing leaked across users: A's rows are not B's.
    const aRows = (await api(`/audit?userId=${a.id}&limit=500`)).body as { userEmail: string }[];
    expect(aRows.every((r) => r.userEmail === a.email)).toBe(true);
  });

  it("No upstream credential appears in any API response", async () => {
    const github = process.env.GITHUB_MCP_TOKEN;
    if (!github) return;
    const bodies = await Promise.all(
      ["/servers", "/tools", "/meta", "/audit?limit=500", "/users"].map(async (p) =>
        JSON.stringify((await api(p)).body),
      ),
    );
    expect(bodies.join("\n")).not.toContain(github);
  });
});
