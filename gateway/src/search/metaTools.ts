import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { slugOf } from "../upstreams/naming.js";
import { tokenize, type Ranker } from "./rank.js";

/**
 * The two tools a client sees in search mode. Neither name contains `__`, so
 * they can never collide with an exposed `<server>__<tool>` name.
 */
export const SEARCH_TOOLS = "search_tools";
export const CALL_TOOL = "call_tool";

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 25;

export const isMetaTool = (name: string): boolean => name === SEARCH_TOOLS || name === CALL_TOOL;

export const META_TOOLS: Tool[] = [
  {
    name: SEARCH_TOOLS,
    description:
      "Find tools by what they do. Returns the best matches with their exact names and input " +
      "schemas; run one with call_tool. Use short keywords (e.g. 'list orders', 'create issue'). " +
      "With an empty query it lists the connected servers and how many tools each has.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing the tool you need." },
        server: { type: "string", description: "Only search this server (its slug)." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `Most results to return (default ${DEFAULT_SEARCH_LIMIT}).`,
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: CALL_TOOL,
    description:
      "Run a tool found with search_tools. Pass its exact name and arguments matching its " +
      "input schema. Permissions and auditing are the same as calling the tool directly.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name from search_tools." },
        arguments: {
          type: "object",
          description: "The tool's arguments.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
];

const searchInput = z.object({
  query: z.string().max(500).default(""),
  server: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

const callInput = z.object({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const errorResult = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

const jsonResult = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

function invalid(err: z.ZodError, tool: string): CallToolResult {
  const problems = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  return errorResult(`Invalid arguments for ${tool}: ${problems}`);
}

export type CallInput = { name: string; arguments?: Record<string, unknown> };

export function parseCallInput(
  raw: unknown,
): { ok: true; value: CallInput } | { ok: false; result: CallToolResult } {
  const parsed = callInput.safeParse(raw ?? {});
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, result: invalid(parsed.error, CALL_TOOL) };
}

/**
 * Runs search_tools over `tools`, which must already be limited to what the
 * caller may use - so a search can't reveal a tool they couldn't call.
 */
export function searchTools(
  tools: Tool[],
  raw: unknown,
  ranker: Ranker,
): { result: CallToolResult; count: number } {
  const parsed = searchInput.safeParse(raw ?? {});
  if (!parsed.success) return { result: invalid(parsed.error, SEARCH_TOOLS), count: 0 };
  const { query, server, limit } = parsed.data;

  const pool = server ? tools.filter((t) => slugOf(t.name) === server) : tools;

  if (tokenize(query).length === 0) {
    const bySlug = new Map<string, string[]>();
    for (const t of pool) {
      const slug = slugOf(t.name) ?? "other";
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), t.name]);
    }
    const servers = [...bySlug].map(([slug, names]) => ({
      server: slug,
      toolCount: names.length,
      examples: names.slice(0, 3),
    }));
    return {
      count: 0,
      result: jsonResult({
        servers,
        hint: "Search with keywords, optionally with 'server', to get tool names and schemas.",
      }),
    };
  }

  const ranked = ranker.rank(query, pool);
  const results = ranked.slice(0, limit).map(({ tool }) => ({
    name: tool.name,
    server: slugOf(tool.name),
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  }));
  return {
    count: results.length,
    result: jsonResult({
      query,
      matched: ranked.length,
      results,
      ...(results.length === 0
        ? {
            hint: "Nothing matched. Try other or fewer keywords, or search with an empty query to list servers.",
          }
        : ranked.length > results.length
          ? {
              hint: `Showing ${results.length} of ${ranked.length}; narrow the query or set 'server'.`,
            }
          : {}),
    }),
  };
}
