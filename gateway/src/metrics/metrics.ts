import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type { AuditOutcome, AuditSource, McpServer } from "../db/schema.js";
import { log } from "../logger.js";

/** Label for a server or tool that didn't resolve, so callers can't mint label values. */
export const UNKNOWN = "unknown";

export interface ToolCallObservation {
  /** Slug of a server that exists; null when the name didn't match one. */
  server: string | null;
  /** The upstream's own tool name; null when the call didn't resolve to a tool. */
  tool: string | null;
  source: AuditSource;
  outcome: AuditOutcome;
  durationMs: number;
}

/** What the router and endpoints talk to; tests and unwired callers get {@link noopMetrics}. */
export interface Metrics {
  observeToolCall(call: ToolCallObservation): void;
  observeSearch(source: AuditSource, results: number): void;
}

export const noopMetrics: Metrics = {
  observeToolCall: () => {},
  observeSearch: () => {},
};

/** Outcomes that mean the call failed. `denied` and `rejected` are policy and client mistakes. */
export const ERROR_OUTCOMES: readonly AuditOutcome[] = ["tool_error", "timeout", "unreachable"];

const SCRAPE_DB_TIMEOUT_MS = 2_000;

/**
 * Prometheus metrics for one gateway process.
 *
 * Counters and histograms live in this process, so each replica reports its own
 * calls and Prometheus sums them. Upstream health is the opposite: it lives in
 * Postgres (the health checker writes it), so the gauges are filled from
 * there on every scrape and every replica reports the same values.
 */
export class GatewayMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly calls = new Counter({
    name: "mcp_gateway_tool_calls_total",
    help: "Tool calls through the gateway, by server, upstream tool, caller and outcome.",
    labelNames: ["server", "tool", "source", "outcome"],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "mcp_gateway_tool_call_duration_seconds",
    help: "Time to complete a tool call that resolved to an upstream tool.",
    labelNames: ["server", "tool", "source"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  private readonly searches = new Counter({
    name: "mcp_gateway_search_tools_total",
    help: "search_tools calls, by caller.",
    labelNames: ["source"],
    registers: [this.registry],
  });
  private readonly searchResults = new Histogram({
    name: "mcp_gateway_search_tools_results",
    help: "Tools returned by each search_tools call.",
    labelNames: ["source"],
    buckets: [0, 1, 2, 5, 10, 25],
    registers: [this.registry],
  });
  private readonly upstreamUp = new Gauge({
    name: "mcp_gateway_upstream_up",
    help: "1 if the upstream's last health check succeeded, 0 otherwise. Disabled servers are omitted.",
    labelNames: ["server"],
    registers: [this.registry],
  });
  private readonly upstreamTools = new Gauge({
    name: "mcp_gateway_upstream_tools",
    help: "Tools in the upstream's cached listing.",
    labelNames: ["server"],
    registers: [this.registry],
  });
  private readonly upstreamChecked = new Gauge({
    name: "mcp_gateway_upstream_last_check_timestamp_seconds",
    help: "When the upstream was last health-checked (Unix time).",
    labelNames: ["server"],
    registers: [this.registry],
  });

  constructor(private readonly listServers: () => Promise<McpServer[]>) {
    collectDefaultMetrics({ register: this.registry });
  }

  observeToolCall(call: ToolCallObservation): void {
    const server = call.server ?? UNKNOWN;
    const tool = call.tool ?? UNKNOWN;
    this.calls.inc({ server, tool, source: call.source, outcome: call.outcome });
    // Calls that never resolved to a tool (unknown name, disabled server) have no latency worth charting.
    if (call.tool !== null) {
      this.duration.observe({ server, tool, source: call.source }, call.durationMs / 1000);
    }
  }

  observeSearch(source: AuditSource, results: number): void {
    this.searches.inc({ source });
    this.searchResults.observe({ source }, results);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** The Prometheus text exposition. Never throws: a failed database read just leaves the upstream gauges out. */
  async render(): Promise<string> {
    await this.refreshUpstreams();
    return this.registry.metrics();
  }

  private async refreshUpstreams(): Promise<void> {
    let servers: McpServer[];
    try {
      servers = await withTimeout(this.listServers(), SCRAPE_DB_TIMEOUT_MS);
    } catch (err) {
      log("warn", "metrics: could not read upstream status", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.upstreamUp.reset();
      this.upstreamTools.reset();
      this.upstreamChecked.reset();
      return;
    }
    this.upstreamUp.reset();
    this.upstreamTools.reset();
    this.upstreamChecked.reset();
    for (const s of servers) {
      if (!s.enabled) continue;
      this.upstreamUp.set({ server: s.slug }, s.status === "connected" ? 1 : 0);
      this.upstreamTools.set({ server: s.slug }, (s.tools_cache ?? []).length);
      if (s.last_checked_at) {
        this.upstreamChecked.set({ server: s.slug }, s.last_checked_at.getTime() / 1000);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
