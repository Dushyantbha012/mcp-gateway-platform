import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface UpstreamConfig {
  id: string;
  slug: string;
  url: string;
  /** Already-decrypted credential headers. Never logged, never returned. */
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * timeout/unreachable: the upstream couldn't be reached or didn't answer in
 * time. protocol: it answered, but with a JSON-RPC error (e.g. invalid
 * arguments) - the session itself is fine.
 */
export type UpstreamErrorKind = "timeout" | "unreachable" | "protocol";

/** A failure to reach or talk to an upstream (as opposed to a tool's own error). */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const CLIENT_INFO = { name: "mcp-gateway", version: "0.3.0" };
const MAX_TOOL_PAGES = 20;

/** Turns SDK/network errors into one short, credential-free sentence. */
export function describeError(err: unknown, slug: string, timeoutMs: number): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return new UpstreamError("timeout", `Upstream '${slug}' timed out after ${timeoutMs}ms`);
  }
  if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) {
    return new UpstreamError(
      "protocol",
      `Upstream '${slug}' returned an error: ${err.message.slice(0, 200)}`,
    );
  }
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) {
      return new UpstreamError(
        "unreachable",
        `Upstream '${slug}' rejected the gateway's credentials (HTTP ${err.code})`,
      );
    }
    return new UpstreamError(
      "unreachable",
      `Upstream '${slug}' returned an error: ${err.message.slice(0, 200)}`,
    );
  }
  // fetch hides the network reason in `cause` (sometimes an AggregateError,
  // when several addresses were tried): ECONNREFUSED, ENOTFOUND, "bad port"...
  type Cause = { code?: string; message?: string; errors?: { code?: string }[] };
  const cause = (err as { cause?: Cause } | undefined)?.cause;
  const reason = cause?.code ?? cause?.errors?.find((e) => e.code)?.code ?? cause?.message;
  if (reason) {
    return new UpstreamError("unreachable", `Upstream '${slug}' is unreachable (${reason})`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new UpstreamError("unreachable", `Upstream '${slug}' failed: ${message.slice(0, 200)}`);
}

/**
 * One long-lived MCP client session to one upstream. Lazily connected,
 * reused across calls, and thrown away after any transport failure so the
 * next request starts a fresh session. Each instance is isolated: nothing
 * one upstream does can block or fail another.
 */
export class UpstreamConnection {
  private client?: Promise<Client>;

  constructor(
    readonly config: UpstreamConfig,
    private readonly opts: { maxResultBytes: number },
  ) {}

  async listTools(timeoutMs = this.config.timeoutMs): Promise<Tool[]> {
    return this.run(timeoutMs, async (client, remaining) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { timeout: remaining() });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    });
  }

  /**
   * Calls one upstream tool. A tool that reports its own failure comes back
   * as an `isError` result (not thrown); only transport problems throw.
   */
  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    let result;
    try {
      result = await this.run(this.config.timeoutMs, (client, remaining) =>
        client.callTool({ name, arguments: args }, undefined, { timeout: remaining() }),
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === "protocol") {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
      throw err;
    }
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > this.opts.maxResultBytes) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Upstream '${this.config.slug}' returned ${size} bytes, over the gateway's ${this.opts.maxResultBytes}-byte limit`,
          },
        ],
      };
    }
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.then((c) => c.close()).catch(() => undefined);
  }

  /**
   * Runs `fn` with a connected client inside one overall deadline (connect +
   * request together never exceed `timeoutMs`). If the upstream says our
   * session no longer exists (HTTP 404, e.g. it restarted), the request
   * never ran there, so reconnecting and retrying once is safe even for
   * tools with side effects.
   */
  private async run<T>(
    timeoutMs: number,
    fn: (client: Client, remaining: () => number) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(deadline - Date.now(), 1);
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect(remaining);
        return await fn(client, remaining);
      } catch (err) {
        const failure = describeError(err, this.config.slug, timeoutMs);
        // A timeout or JSON-RPC error leaves the session usable, and closing
        // it would also abort other in-flight calls on it.
        if (failure.kind === "unreachable") await this.close();
        const sessionGone = err instanceof StreamableHTTPError && err.code === 404;
        if (sessionGone && attempt === 0 && Date.now() < deadline) continue;
        throw failure;
      }
    }
  }

  private connect(remaining: () => number): Promise<Client> {
    if (!this.client) {
      const client = new Client(CLIENT_INFO);
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        // Only the gateway's own stored credential is sent. The caller's
        // Authorization header never reaches an upstream (no token
        // passthrough), so an upstream can't replay a user's gateway key.
        requestInit: { headers: this.config.headers },
      });
      this.client = client
        .connect(transport, { timeout: remaining() })
        .then(() => client)
        .catch(async (err) => {
          this.client = undefined;
          await client.close().catch(() => undefined);
          throw err;
        });
    }
    return this.client;
  }
}
