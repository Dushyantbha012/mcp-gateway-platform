import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv } from "./config.js";
import { createApp } from "./http.js";
import { Upstream } from "./upstream.js";

const fixture = fileURLToPath(new URL("./test/fixtureServer.ts", import.meta.url));
const token = "bridge-test-token-0123456789";
const text = (r: CallToolResult) =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** A bridge in front of the fixture, on a free port. */
async function startBridge(timeoutMs = 5_000) {
  const exits: string[] = [];
  const upstream = new Upstream(
    {
      command: process.execPath,
      args: ["--import", "tsx", fixture],
      env: childEnv({ ...process.env, FIXTURE_SETTING: "from-image", BRIDGE_AUTH_TOKEN: token }),
    },
    (reason) => exits.push(reason),
  );
  await upstream.start();
  const http: Server = createApp({ upstream, authToken: token, timeoutMs }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  const connect = async (key = token) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const stop = async () => {
    await Promise.all(clients.map((c) => c.close()));
    await upstream.close();
    await new Promise((r) => http.close(r));
  };
  return { url, upstream, exits, connect, stop };
}

describe("mcp-bridge", () => {
  let bridge: Awaited<ReturnType<typeof startBridge>>;
  beforeAll(async () => {
    bridge = await startBridge();
  }, 20_000);
  afterAll(() => bridge.stop());

  it("serves the stdio server's tools over HTTP, with their annotations", async () => {
    const client = await bridge.connect();
    expect(client.getServerVersion()).toMatchObject({ name: "fixture", version: "1.2.3" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["crash", "echo", "env", "fail", "slow"]);
    expect(tools.find((t) => t.name === "echo")).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: { properties: { text: { type: "string" } } },
    });
  });

  it("forwards calls, including tool errors, and many at once to the one child", async () => {
    const client = await bridge.connect();
    const results = (await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        client.callTool({ name: "echo", arguments: { text: `n${i}` } }),
      ),
    )) as CallToolResult[];
    expect(results.map(text)).toEqual(Array.from({ length: 10 }, (_, i) => `echo: n${i}`));

    const failed = (await client.callTool({ name: "fail", arguments: {} })) as CallToolResult;
    expect(failed.isError).toBe(true);
    expect(text(failed)).toBe("it went wrong");
  });

  it("gives the child the image's environment but never the bridge token", async () => {
    const client = await bridge.connect();
    const env = async (name: string) =>
      text((await client.callTool({ name: "env", arguments: { name } })) as CallToolResult);
    expect(await env("FIXTURE_SETTING")).toBe("from-image");
    expect(await env("BRIDGE_AUTH_TOKEN")).toBe("<unset>");
  });

  it("refuses a missing or wrong token, and GET/DELETE", async () => {
    const err = await bridge.connect("wrong-token").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as StreamableHTTPError).code).toBe(401);
    expect((await fetch(`${bridge.url}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${bridge.url}/mcp`)).status).toBe(405);
    expect((await fetch(`${bridge.url}/readyz`)).status).toBe(200);
  });
});

describe("mcp-bridge timeouts and exits", () => {
  it("times out a slow call without breaking the next one", async () => {
    const bridge = await startBridge(300);
    try {
      const client = await bridge.connect();
      const slow = (await client
        .callTool({ name: "slow", arguments: { ms: 2_000 } })
        .catch((e: Error) => e)) as Error | CallToolResult;
      // The forwarded request's timeout comes back as a JSON-RPC error.
      expect(slow).toBeInstanceOf(Error);
      expect(String((slow as Error).message)).toMatch(/timed out/i);
      const ok = (await client.callTool({
        name: "echo",
        arguments: { text: "after" },
      })) as CallToolResult;
      expect(text(ok)).toBe("echo: after");
    } finally {
      await bridge.stop();
    }
  }, 20_000);

  it("reports the child exiting, and stops claiming to be ready", async () => {
    const bridge = await startBridge();
    try {
      const client = await bridge.connect();
      await client.callTool({ name: "crash", arguments: {} }).catch(() => undefined);
      await expect.poll(() => bridge.exits).toEqual(["the MCP server process exited"]);
      expect((await fetch(`${bridge.url}/readyz`)).status).toBe(503);
      const res = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(503);
    } finally {
      await bridge.stop();
    }
  }, 20_000);
});
