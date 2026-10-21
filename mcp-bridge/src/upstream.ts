import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "./logger.js";

/**
 * The one long-lived stdio server behind the bridge. Requests from many HTTP
 * callers share it; the SDK client matches responses to requests by id.
 *
 * There is no respawn: if the child exits, `onExit` fires and the process
 * should exit too, so Kubernetes restarts the pod and a crash loop shows up as
 * CrashLoopBackOff (which the provisioner reports) rather than being hidden.
 */
export class Upstream {
  readonly client = new Client({ name: "mcp-bridge", version: "1.0.0" });
  private transport: StdioClientTransport;
  private connected = false;
  private closing = false;

  constructor(
    opts: { command: string; args: string[]; env: Record<string, string> },
    private onExit: (reason: string) => void,
  ) {
    this.transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      // Explicit: the SDK's default passes only a handful of variables (PATH,
      // HOME, ...) and the image's own configuration would be lost.
      env: opts.env,
      // The server's logs go to the container's, where `kubectl logs` finds them.
      stderr: "inherit",
    });
  }

  get ready() {
    return this.connected;
  }

  async start(timeoutMs?: number): Promise<void> {
    this.client.onclose = () => {
      this.connected = false;
      if (!this.closing) this.onExit("the MCP server process exited");
    };
    await this.client.connect(this.transport, { timeout: timeoutMs });
    this.connected = true;
    const v = this.client.getServerVersion();
    log("info", "stdio server connected", { server: v?.name, version: v?.version });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.client.close().catch(() => undefined);
  }
}
