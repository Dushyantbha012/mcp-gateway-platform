import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

/**
 * A real MCP server over real HTTP for gateway tests, with switchable failure
 * modes. `behavior` can be changed mid-test to simulate an upstream going
 * down, hanging, or rejecting the gateway's credential.
 */
export type Behavior = "ok" | "hang" | "unauthorized" | "http500";

export interface FakeUpstream {
  url: string;
  behavior: Behavior;
  /** Headers of every HTTP request received, in order. */
  requests: IncomingHttpHeaders[];
  /** How many times each tool actually ran. */
  calls: Record<string, number>;
  /** MCP sessions started (stateful mode only). */
  sessionsCreated: number;
  /** Forget all sessions, like a restarted server (stateful mode only). */
  expireSessions(): void;
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  toolNames?: string[];
  stateful?: boolean;
  behavior?: Behavior;
}

function buildServer(fake: FakeUpstream, toolNames: string[]): McpServer {
  const server = new McpServer({ name: "fake-upstream", version: "1.0.0" });
  const count = (name: string) => {
    fake.calls[name] = (fake.calls[name] ?? 0) + 1;
  };
  for (const name of toolNames) {
    server.registerTool(
      name,
      { description: `Fake ${name}`, inputSchema: { value: z.string().optional() } },
      async ({ value }) => {
        count(name);
        return { content: [{ type: "text", text: `${name}:${value ?? ""}` }] };
      },
    );
  }
  server.registerTool("fail", { description: "Always reports a tool error" }, async () => {
    count("fail");
    return { isError: true, content: [{ type: "text", text: "Order 999 not found" }] };
  });
  server.registerTool(
    "big",
    { description: "Returns a large result", inputSchema: { bytes: z.number() } },
    async ({ bytes }) => {
      count("big");
      return { content: [{ type: "text", text: "x".repeat(bytes) }] };
    },
  );
  return server;
}

export async function startFakeUpstream(opts: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const toolNames = opts.toolNames ?? ["list_products", "echo"];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();

  const fake: FakeUpstream = {
    url: "",
    behavior: opts.behavior ?? "ok",
    requests: [],
    calls: {},
    sessionsCreated: 0,
    expireSessions: () => sessions.clear(),
    close: async () => {},
  };

  app.use((req, res, next) => {
    fake.requests.push(req.headers);
    if (fake.behavior === "hang") return; // never answer
    if (fake.behavior === "unauthorized") {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (fake.behavior === "http500") {
      res.status(500).send("<html>boom</html>");
      return;
    }
    next();
  });

  app.post("/mcp", express.json(), async (req, res) => {
    if (!opts.stateful) {
      const server = buildServer(fake, toolNames);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => void server.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !transport) {
      res
        .status(404)
        .json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          fake.sessionsCreated++;
          sessions.set(id, transport!);
        },
      });
      await buildServer(fake, toolNames).connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (_req, res) => {
    res.status(405).end();
  });
  app.delete("/mcp", (_req, res) => {
    res.status(200).end();
  });

  const http: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  fake.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  fake.close = async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  };
  return fake;
}

/** A URL on which nothing is listening (connection refused). */
export async function deadUrl(): Promise<string> {
  const http = express().listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const { port } = http.address() as AddressInfo;
  await new Promise((resolve) => http.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}
