import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { writeAudit } from "../audit/writer.js";
import type { Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import type { AuditOutcome, AuditSource, McpServer } from "../db/schema.js";
import { listServers, recordServerHealth } from "../db/servers.js";
import { UpstreamError } from "./connection.js";
import { buildToolIndex, slugOf, type ToolIndex } from "./naming.js";
import type { UpstreamRegistry } from "./registry.js";

export interface CallContext {
  principal: Principal;
  source: AuditSource;
}

const errorResult = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

function indexOf(servers: McpServer[]): ToolIndex {
  return buildToolIndex(
    servers.map((s) => ({ slug: s.slug, name: s.name, tools: (s.tools_cache ?? []) as Tool[] })),
  );
}

/**
 * The one path every tool call takes - from the MCP endpoint now, and from
 * the chat agent in Phase 5 - so routing, timeouts and audit logging can't
 * differ between them.
 */
export class ToolRouter {
  constructor(
    private readonly db: Db,
    private readonly registry: UpstreamRegistry,
  ) {}

  /**
   * Tools of every enabled server whose last health check succeeded, from
   * the health checker's cache: listing never waits on an upstream.
   */
  async listTools(): Promise<Tool[]> {
    const servers = await listServers(this.db);
    return indexOf(servers.filter((s) => s.enabled && s.status === "connected")).tools;
  }

  async callTool(
    ctx: CallContext,
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const startedAt = performance.now();
    const servers = await listServers(this.db);
    // Routes cover every enabled server, even ones currently marked
    // unreachable: a client may still hold their tools from an earlier list,
    // and the server may be back. The call itself decides.
    const enabled = servers.filter((s) => s.enabled);
    const route = indexOf(enabled).routes.get(name);
    const server = route && enabled.find((s) => s.slug === route.slug);

    const finish = async (
      outcome: AuditOutcome,
      result: CallToolResult,
      serverSlug: string | null,
      error?: string,
    ) => {
      await writeAudit(this.db, {
        principal: ctx.principal,
        source: ctx.source,
        serverSlug,
        toolName: name,
        durationMs: performance.now() - startedAt,
        outcome,
        error,
      });
      return result;
    };

    if (!route || !server) {
      const slug = slugOf(name);
      const known = servers.find((s) => s.slug === slug);
      const message =
        known && !known.enabled
          ? `Server '${known.slug}' is disabled`
          : `Unknown tool '${name}'. Call tools/list to see available tools.`;
      return finish("rejected", errorResult(message), known?.slug ?? null, message);
    }

    try {
      const result = await this.registry.get(server).callTool(route.upstreamName, args);
      if (result.isError) {
        const text = result.content?.find((c) => c.type === "text");
        return finish(
          "tool_error",
          result,
          server.slug,
          text?.type === "text" ? text.text : undefined,
        );
      }
      return finish("success", result, server.slug);
    } catch (err) {
      const failure =
        err instanceof UpstreamError ? err : new UpstreamError("unreachable", String(err));
      if (failure.kind === "unreachable") {
        // Show it on the dashboard now rather than at the next health pass.
        await recordServerHealth(this.db, server.id, {
          status: "unreachable",
          error: failure.message,
        });
      }
      const outcome = failure.kind === "timeout" ? "timeout" : "unreachable";
      return finish(outcome, errorResult(failure.message), server.slug, failure.message);
    }
  }
}
