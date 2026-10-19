import { describe, expect, it } from "vitest";
import type { McpServer } from "../db/schema.js";
import { GatewayMetrics } from "./metrics.js";

const server = (overrides: Partial<McpServer>): McpServer =>
  ({
    id: "1",
    slug: "shop",
    name: "Shop",
    enabled: true,
    status: "connected",
    tools_cache: [{ name: "a" }, { name: "b" }],
    last_checked_at: new Date(1_700_000_000_000),
    ...overrides,
  }) as McpServer;

describe("GatewayMetrics", () => {
  it("counts calls by server, tool, source and outcome, and times the ones that reached a tool", async () => {
    const m = new GatewayMetrics(async () => []);
    m.observeToolCall({
      server: "shop",
      tool: "list_orders",
      source: "mcp",
      outcome: "success",
      durationMs: 120,
    });
    m.observeToolCall({
      server: "shop",
      tool: "list_orders",
      source: "mcp",
      outcome: "timeout",
      durationMs: 10_000,
    });
    const text = await m.render();
    expect(text).toContain(
      'mcp_gateway_tool_calls_total{server="shop",tool="list_orders",source="mcp",outcome="success"} 1',
    );
    expect(text).toContain('outcome="timeout"} 1');
    expect(text).toContain(
      'mcp_gateway_tool_call_duration_seconds_count{server="shop",tool="list_orders",source="mcp"} 2',
    );
    expect(text).toMatch(
      /mcp_gateway_tool_call_duration_seconds_bucket\{le="0\.25",server="shop",tool="list_orders",source="mcp"\} 1/,
    );
  });

  it("labels calls that resolved to nothing 'unknown' and records no latency for them", async () => {
    const m = new GatewayMetrics(async () => []);
    m.observeToolCall({
      server: null,
      tool: null,
      source: "chat",
      outcome: "rejected",
      durationMs: 3,
    });
    const text = await m.render();
    expect(text).toContain(
      'mcp_gateway_tool_calls_total{server="unknown",tool="unknown",source="chat",outcome="rejected"} 1',
    );
    expect(text).not.toContain("mcp_gateway_tool_call_duration_seconds_count{");
  });

  it("reports upstream up/down from the database at scrape time, omitting disabled servers", async () => {
    let servers = [
      server({ slug: "shop" }),
      server({ slug: "broken", status: "unreachable", tools_cache: null, last_checked_at: null }),
      server({ slug: "off", enabled: false }),
    ];
    const m = new GatewayMetrics(async () => servers);
    let text = await m.render();
    expect(text).toContain('mcp_gateway_upstream_up{server="shop"} 1');
    expect(text).toContain('mcp_gateway_upstream_up{server="broken"} 0');
    expect(text).toContain('mcp_gateway_upstream_tools{server="shop"} 2');
    expect(text).toContain('mcp_gateway_upstream_tools{server="broken"} 0');
    expect(text).toContain(
      'mcp_gateway_upstream_last_check_timestamp_seconds{server="shop"} 1700000000',
    );
    expect(text).not.toContain('server="off"');

    // A server that is removed stops being reported rather than going stale.
    servers = [server({ slug: "shop", status: "unreachable" })];
    text = await m.render();
    expect(text).toContain('mcp_gateway_upstream_up{server="shop"} 0');
    expect(text).not.toContain('server="broken"');
  });

  it("still serves counters when the database read fails", async () => {
    const m = new GatewayMetrics(async () => {
      throw new Error("db down");
    });
    m.observeSearch("mcp", 3);
    const text = await m.render();
    expect(text).toContain('mcp_gateway_search_tools_total{source="mcp"} 1');
    expect(text).not.toContain("mcp_gateway_upstream_up{");
  });

  it("includes process metrics", async () => {
    const text = await new GatewayMetrics(async () => []).render();
    expect(text).toContain("process_cpu_user_seconds_total");
  });
});
