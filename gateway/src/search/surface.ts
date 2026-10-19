import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "../db/apiKeys.js";
import { noopMetrics, type Metrics } from "../metrics/metrics.js";
import type { CallContext, ToolRouter } from "../upstreams/router.js";
import {
  CALL_TOOL,
  isMetaTool,
  META_TOOLS,
  parseCallInput,
  SEARCH_TOOLS,
  searchTools,
} from "./metaTools.js";
import { Bm25Ranker, type Ranker } from "./rank.js";

/** `off`: list every tool. `on`: only the two meta-tools. `auto`: meta-tools once the caller sees more than the threshold. */
export type SearchMode = "off" | "on" | "auto";
/** What one request asks for, overriding the configured mode. */
export type SurfaceOverride = "search" | "full";

export interface SurfaceOptions {
  mode: SearchMode;
  autoThreshold: number;
}

export const SEARCH_HINT = "Use search_tools to find a tool, then call_tool to run it.";

/** "list orders" -> `query: "list orders" · 3 matches`, whatever the caller sent. */
function searchDetail(args: Record<string, unknown> | undefined, count: number): string {
  const query = typeof args?.query === "string" ? args.query.trim().slice(0, 200) : "";
  const server = typeof args?.server === "string" ? ` · server: ${args.server.slice(0, 64)}` : "";
  const matches = `${count} ${count === 1 ? "match" : "matches"}`;
  return query ? `query: "${query}"${server} · ${matches}` : `list servers${server}`;
}

/**
 * What a caller sees of the gateway's tools: either the full list, or just
 * `search_tools` + `call_tool` so hundreds of tools don't fill their context.
 * Both are views over `ToolRouter`, which does the permission checks, routing
 * and auditing - search never sees a tool the caller couldn't call, and
 * `call_tool` is audited and measured under the real server and tool.
 */
export class ToolSurface {
  constructor(
    private readonly router: ToolRouter,
    private readonly options: SurfaceOptions,
    private readonly metrics: Metrics = noopMetrics,
    private readonly ranker: Ranker = new Bm25Ranker(),
  ) {}

  get mode(): SearchMode {
    return this.options.mode;
  }

  async listTools(principal: Principal, override?: SurfaceOverride): Promise<Tool[]> {
    const tools = await this.router.listTools(principal);
    return this.useSearch(tools.length, override) ? META_TOOLS : tools;
  }

  /**
   * The meta-tools are handled whatever the mode: their names can't clash with
   * a real tool, and they only expose what the caller could already list.
   */
  async callTool(
    ctx: CallContext,
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    if (name === SEARCH_TOOLS) {
      const startedAt = performance.now();
      const { result, count } = searchTools(
        await this.router.listTools(ctx.principal),
        args,
        this.ranker,
      );
      this.metrics.observeSearch(ctx.source, count);
      // Audited like any call: a search says what the user was looking for, and
      // an upstream is never involved so there is no server to attribute it to.
      await this.router.auditGatewayCall(ctx, {
        toolName: SEARCH_TOOLS,
        durationMs: performance.now() - startedAt,
        detail: searchDetail(args, count),
      });
      return result;
    }
    if (name === CALL_TOOL) {
      const parsed = parseCallInput(args);
      if (!parsed.ok) return parsed.result;
      const { name: inner, arguments: innerArgs } = parsed.value;
      if (isMetaTool(inner)) {
        return {
          isError: true,
          content: [{ type: "text", text: `'${inner}' is not a tool to run. ${SEARCH_HINT}` }],
        };
      }
      return this.router.callTool(
        { ...ctx, unknownToolHint: `Use search_tools to find the right name.` },
        inner,
        innerArgs,
      );
    }
    return this.router.callTool(ctx, name, args);
  }

  private useSearch(toolCount: number, override?: SurfaceOverride): boolean {
    if (override) return override === "search";
    switch (this.options.mode) {
      case "on":
        return true;
      case "auto":
        return toolCount > this.options.autoThreshold;
      default:
        return false;
    }
  }
}
