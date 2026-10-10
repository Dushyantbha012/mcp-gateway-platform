import type { Db } from "../db/db.js";
import type { McpServer } from "../db/schema.js";
import { getServer, listServers, recordServerHealth } from "../db/servers.js";
import { log } from "../logger.js";
import { UpstreamError } from "./connection.js";
import type { UpstreamRegistry } from "./registry.js";

export type DisplayStatus = "connected" | "unreachable" | "disabled" | "unknown";

/** What the dashboard shows: disabled wins over the last health result. */
export function displayStatus(server: Pick<McpServer, "enabled" | "status">): DisplayStatus {
  return server.enabled ? server.status : "disabled";
}

/**
 * Periodically lists every enabled upstream's tools. The result is the
 * server's status and the cached tool list that the gateway's own
 * `tools/list` serves - so a client listing tools never waits on a slow
 * upstream; only this background loop does.
 */
export class HealthChecker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly registry: UpstreamRegistry,
    private readonly opts: { intervalMs: number; listTimeoutMs: number },
  ) {}

  /** Checks one server now and records the outcome. Never throws for upstream failures. */
  async check(server: McpServer): Promise<McpServer> {
    try {
      const tools = await this.registry.get(server).listTools(this.opts.listTimeoutMs);
      await recordServerHealth(this.db, server.id, { status: "connected", tools });
    } catch (err) {
      const error =
        err instanceof UpstreamError ? err.message : `Health check failed: ${String(err)}`;
      if (server.status !== "unreachable") {
        log("warn", "upstream unreachable", { server: server.slug, error });
      }
      await recordServerHealth(this.db, server.id, { status: "unreachable", error });
    }
    return (await getServer(this.db, server.id)) ?? server;
  }

  /** One pass over all servers, in parallel; one slow server doesn't delay the others' results. */
  async checkAll(): Promise<void> {
    const servers = await listServers(this.db);
    const enabled = servers.filter((s) => s.enabled);
    await this.registry.retain(new Set(enabled.map((s) => s.id)));
    await Promise.allSettled(enabled.map((s) => this.check(s)));
  }

  start(): void {
    this.stopped = false;
    const tick = async () => {
      this.running = this.checkAll().catch((err) =>
        log("error", "health check pass failed", { error: String(err) }),
      );
      await this.running;
      // Scheduled after the pass finishes, so passes never overlap.
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.intervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
