import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { writeAudit } from "../audit/writer.js";
import type { Principal } from "../db/apiKeys.js";
import type { Db } from "../db/db.js";
import type { AuditOutcome, AuditSource, McpServer } from "../db/schema.js";
import { gateWrite } from "../db/approvals.js";
import { rulesFor } from "../db/permissions.js";
import { listServers, recordServerHealth } from "../db/servers.js";
import { noopMetrics, type Metrics } from "../metrics/metrics.js";
import { isAllowed, type MemberDefault } from "../permissions/evaluate.js";
import { currentRequestId } from "../requestContext.js";
import { UpstreamError } from "./connection.js";
import { buildToolIndex, slugOf, type ToolIndex } from "./naming.js";
import type { UpstreamRegistry } from "./registry.js";

/** A tool as an approval prompt describes it. */
export interface ToolInfo {
  name: string;
  server: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

export interface CallContext {
  principal: Principal;
  source: AuditSource;
  /** Request that triggered the call; defaults to the one in the async context. */
  requestId?: string;
  /** Replaces the "call tools/list" advice in the unknown-tool message. */
  unknownToolHint?: string;
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
    private readonly metrics: Metrics = noopMetrics,
    /** What members may use when no rule matches; see `decide`. */
    readonly memberDefault: MemberDefault = "allowAll",
    /**
     * Hold every write an MCP client calls until its user approves it in the
     * dashboard (see `gateWrite`). Chat has its own prompt, so it isn't held here.
     */
    private readonly holdMcpWrites = false,
  ) {}

  /**
   * Tools of every enabled server whose last health check succeeded, from
   * the health checker's cache: listing never waits on an upstream. Tools the
   * caller isn't permitted to use are left out, so they can't see (or have the
   * chat model see) what they can't call.
   */
  async listTools(principal: Principal): Promise<Tool[]> {
    const servers = await listServers(this.db);
    const index = indexOf(servers.filter((s) => s.enabled && s.status === "connected"));
    if (principal.role === "admin") return index.tools;
    const rules = await rulesFor(this.db, principal);
    return index.tools.filter((t) => {
      const route = index.routes.get(t.name);
      return (
        route !== undefined &&
        isAllowed(
          principal,
          { serverSlug: route.slug, toolName: route.upstreamName, readOnly: route.readOnly },
          rules,
          this.memberDefault,
        )
      );
    });
  }

  /**
   * Whether the upstream marks `name` read-only. `undefined` for a tool that
   * isn't routable (the call will be rejected anyway); a tool with no
   * `readOnlyHint` counts as a write.
   */
  async isReadOnly(name: string): Promise<boolean | undefined> {
    const enabled = (await listServers(this.db)).filter((s) => s.enabled);
    return indexOf(enabled).routes.get(name)?.readOnly;
  }

  /**
   * What the approval prompts show about a tool: the upstream's own description and
   * hints, so the user judges the tool and not just the arguments the model chose.
   */
  async describeTool(name: string): Promise<ToolInfo | undefined> {
    const enabled = (await listServers(this.db)).filter((s) => s.enabled);
    const index = indexOf(enabled);
    const route = index.routes.get(name);
    const tool = index.tools.find((t) => t.name === name);
    if (!route || !tool) return undefined;
    const hints = tool.annotations ?? {};
    return {
      name,
      server: route.slug,
      description: tool.description ?? "",
      readOnly: route.readOnly,
      destructive: hints.destructiveHint,
      idempotent: hints.idempotentHint,
    };
  }

  /**
   * Audits a gateway-level call that never reaches an upstream (today: the
   * `search_tools` meta-tool), so it shows in the same log as everything else.
   */
  async auditGatewayCall(
    ctx: CallContext,
    entry: { toolName: string; durationMs: number; detail?: string },
  ): Promise<void> {
    await writeAudit(this.db, {
      principal: ctx.principal,
      source: ctx.source,
      serverSlug: null,
      toolName: entry.toolName,
      durationMs: entry.durationMs,
      outcome: "success",
      detail: entry.detail,
      requestId: ctx.requestId ?? currentRequestId(),
    });
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
      const durationMs = performance.now() - startedAt;
      this.metrics.observeToolCall({
        server: serverSlug,
        tool: route?.upstreamName ?? null,
        source: ctx.source,
        outcome,
        durationMs,
      });
      await writeAudit(this.db, {
        principal: ctx.principal,
        source: ctx.source,
        serverSlug,
        toolName: name,
        durationMs,
        outcome,
        error,
        requestId: ctx.requestId ?? currentRequestId(),
      });
      return result;
    };

    if (!route || !server) {
      const slug = slugOf(name);
      const known = servers.find((s) => s.slug === slug);
      const message =
        known && !known.enabled
          ? `Server '${known.slug}' is disabled`
          : `Unknown tool '${name}'. ${ctx.unknownToolHint ?? "Call tools/list to see available tools."}`;
      return finish("rejected", errorResult(message), known?.slug ?? null, message);
    }

    // Checked before anything reaches the upstream, with rules read now: a
    // client holding an old tools/list can't use a tool that was just denied.
    if (ctx.principal.role !== "admin") {
      const rules = await rulesFor(this.db, ctx.principal);
      if (
        !isAllowed(
          ctx.principal,
          { serverSlug: route.slug, toolName: route.upstreamName, readOnly: route.readOnly },
          rules,
          this.memberDefault,
        )
      ) {
        const message = `You don't have permission to use '${name}'`;
        return finish("denied", errorResult(message), server.slug, message);
      }
    }

    if (this.holdMcpWrites && ctx.source === "mcp" && !route.readOnly) {
      const gate = await gateWrite(this.db, ctx.principal.userId, name, args);
      if (gate.kind !== "run") {
        const message =
          gate.kind === "denied"
            ? `The user declined '${name}' (request ${gate.id}). Do not retry it unless they ask again.`
            : `'${name}' changes data, so the user must approve it first (request ${gate.id}). ` +
              `Tell them to open Approvals in the gateway dashboard, check the arguments and ` +
              `approve; then call it again with the same arguments.`;
        return finish("held", errorResult(message), server.slug, message);
      }
    }

    try {
      const result = await (await this.registry.get(server)).callTool(route.upstreamName, args);
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
