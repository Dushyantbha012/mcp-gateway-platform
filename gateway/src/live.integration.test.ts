import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Live tests against the gateway deployed in k3d, through its Ingress, with
 * the real WooCommerce MCP server behind it. Skipped unless the env below is
 * set; scripts/verify-phase3.sh sets it from the cluster's Secrets.
 */
const env = {
  url: process.env.GATEWAY_LIVE_URL,
  adminKey: process.env.GATEWAY_LIVE_ADMIN_KEY,
  wcToken: process.env.GATEWAY_LIVE_WC_TOKEN,
};
const enabled = Object.values(env).every(Boolean);
const WOO_TOOLS = [
  "woocommerce__create_product",
  "woocommerce__get_order",
  "woocommerce__list_orders",
  "woocommerce__list_products",
  "woocommerce__update_order_status",
];

describe.skipIf(!enabled)("live: deployed gateway", () => {
  const run = Date.now().toString(36);
  const createdServers: string[] = [];
  const clients: Client[] = [];
  let wooId: string;

  async function api(path: string, init: RequestInit & { key?: string } = {}) {
    const res = await fetch(`${env.url}/api${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${init.key ?? env.adminKey}`,
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
  }

  async function connect(key: string) {
    const client = new Client({ name: "live-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  async function status401(promise: Promise<unknown>) {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamableHTTPError);
    expect((err as StreamableHTTPError).code).toBe(401);
  }

  const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

  beforeAll(async () => {
    const servers = (await api("/servers")).body as { id: string; slug: string }[];
    wooId = servers.find((s) => s.slug === "woocommerce")!.id;
    // A previous interrupted run may have left woocommerce disabled.
    await api(`/servers/${wooId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    for (const id of createdServers) await api(`/servers/${id}`, { method: "DELETE" });
    await api(`/servers/${wooId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  });

  it("lists the five WooCommerce tools and calls one, via the gateway only", async () => {
    const client = await connect(env.adminKey!);
    const tools = (await names(client)).filter((n) => n.startsWith("woocommerce__"));
    expect(tools.sort()).toEqual(WOO_TOOLS);

    const result = (await client.callTool({
      name: "woocommerce__list_products",
      // Searched for, not assumed to be on page one: later phases create test products.
      arguments: { search: "Urumi" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("Urumi");
  });

  it("rejects missing and unknown keys", async () => {
    await status401(connect("mgw_00000000_" + "a".repeat(43)));
    const res = await fetch(`${env.url}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("member: own key works through an MCP client until revoked, and is audited as them", async () => {
    const email = `live-${run}@example.com`;
    const user = (
      await api("/users", { method: "POST", body: JSON.stringify({ email, name: "Live" }) })
    ).body;
    const issued = (
      await api(`/users/${user.id}/keys`, { method: "POST", body: JSON.stringify({ name: "cli" }) })
    ).body;

    const client = await connect(issued.key);
    // Members are read-only by default: the store's two write tools are hidden from them.
    const memberNames = await names(client);
    expect(memberNames).toEqual(
      expect.arrayContaining(
        WOO_TOOLS.filter((n) => !/create_product|update_order_status/.test(n)),
      ),
    );
    expect(memberNames).not.toContain("woocommerce__create_product");
    expect(memberNames).not.toContain("woocommerce__update_order_status");
    const orders = (await client.callTool({
      name: "woocommerce__list_orders",
      arguments: {},
    })) as CallToolResult;
    expect(orders.isError).toBeFalsy();

    // Members can't administer.
    expect((await api("/users", { key: issued.key })).status).toBe(403);

    await api(`/keys/${issued.id}`, { method: "DELETE" });
    await status401(client.listTools());

    const audit = (await api(`/audit?userId=${user.id}`)).body;
    expect(audit[0]).toMatchObject({
      userEmail: email,
      apiKeyId: issued.id,
      server: "woocommerce",
      tool: "woocommerce__list_orders",
      outcome: "success",
      source: "mcp",
    });
  });

  it("a dead and a hanging upstream don't affect listing or calls to WooCommerce", async () => {
    const add = async (slug: string, url: string) => {
      const res = await api("/servers", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug, url, timeoutMs: 1500 }),
      });
      expect(res.status).toBe(201);
      createdServers.push(res.body.id);
      return res.body;
    };
    // Nothing behind this name: DNS fails at once.
    const dead = await add(`dead-${run}`, "http://nothing.example.invalid/mcp");
    // Non-routable address: before Phase 8 packets vanished and the connection
    // hung. It is private, so values-local.yaml allowlists it for the SSRF guard
    // (test fixture), and the egress NetworkPolicy now refuses it at once - so
    // this is "unreachable" either way. The hang itself is covered by the
    // fake-upstream tests; what matters live is that nothing else is slowed.
    const hanging = await add(`hang-${run}`, "http://10.255.255.1/mcp");
    expect(dead).toMatchObject({ status: "unreachable" });
    expect(dead.lastError).toMatch(/ENOTFOUND/);
    expect(hanging).toMatchObject({ status: "unreachable" });
    expect(hanging.lastError).toMatch(/timed out|unreachable/);

    const client = await connect(env.adminKey!);
    const startedAt = Date.now();
    const listed = await names(client);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(listed).toEqual(expect.arrayContaining(WOO_TOOLS));
    const result = (await client.callTool({
      name: "woocommerce__list_products",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
  }, 20_000);

  it("a real external upstream (DeepWiki) works through the gateway", async (ctx) => {
    const res = await api("/servers", {
      method: "POST",
      body: JSON.stringify({
        slug: `deepwiki-${run}`,
        name: "DeepWiki",
        url: "https://mcp.deepwiki.com/mcp",
        timeoutMs: 30_000,
      }),
    });
    createdServers.push(res.body.id);
    if (res.body.status !== "connected") {
      // Third-party service or no internet: report, don't fail Phase 3 on it.
      console.warn(`DeepWiki unreachable, skipping: ${res.body.lastError}`);
      ctx.skip();
    }
    const tools = res.body.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain(`deepwiki-${run}__read_wiki_structure`);

    const client = await connect(env.adminKey!);
    const result = (await client.callTool({
      name: `deepwiki-${run}__read_wiki_structure`,
      arguments: { repoName: "modelcontextprotocol/typescript-sdk" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
  }, 60_000);

  it("disabling WooCommerce hides its tools and rejects calls; re-enabling restores them", async () => {
    const client = await connect(env.adminKey!);
    const off = await api(`/servers/${wooId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.body.status).toBe("disabled");
    expect((await names(client)).some((n) => n.startsWith("woocommerce__"))).toBe(false);
    const rejected = (await client.callTool({
      name: "woocommerce__list_products",
      arguments: {},
    })) as CallToolResult;
    expect(JSON.stringify(rejected.content)).toContain("Server 'woocommerce' is disabled");

    const on = await api(`/servers/${wooId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.body.status).toBe("connected");
    expect(await names(client)).toEqual(expect.arrayContaining(WOO_TOOLS));
  });

  it("never exposes the WooCommerce credential through the API", async () => {
    for (const path of ["/servers", `/servers/${wooId}`]) {
      const res = await api(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(env.wcToken);
    }
  });
});
