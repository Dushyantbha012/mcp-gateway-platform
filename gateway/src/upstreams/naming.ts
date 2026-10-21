import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeTool } from "../security/untrusted.js";

/**
 * Collision scheme: every aggregated tool is exposed as `<slug>__<tool>`.
 *
 * A slug is lowercase letters, digits and single dashes - never `_` - so the
 * first `__` in an exposed name always ends the slug, even when the
 * upstream's own tool name contains `__`.
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
export const SEPARATOR = "__";

// Claude and Gemini both reject function names longer than 64 characters or
// outside this charset, so every exposed name must fit both.
export const MAX_TOOL_NAME = 64;
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** The slug part of an exposed name, or null if it has no separator. */
export function slugOf(exposedName: string): string | null {
  const i = exposedName.indexOf(SEPARATOR);
  return i > 0 ? exposedName.slice(0, i) : null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Exposed name for one upstream tool. The plain `slug__tool` form is used
 * whenever it's valid; otherwise (unsafe characters or too long) the tool
 * part is sanitised and truncated with a hash of the original name, so the
 * result is still deterministic and unique per original name.
 */
export function exposedToolName(slug: string, tool: string): string {
  const plain = `${slug}${SEPARATOR}${tool}`;
  if (plain.length <= MAX_TOOL_NAME && SAFE_NAME.test(tool)) return plain;
  const suffix = `_${shortHash(tool)}`;
  const room = MAX_TOOL_NAME - slug.length - SEPARATOR.length - suffix.length;
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, Math.max(room, 0));
  return `${slug}${SEPARATOR}${safe}${suffix}`;
}

export interface UpstreamTools {
  slug: string;
  name: string;
  tools: Tool[];
}

export interface Route {
  slug: string;
  upstreamName: string;
  /** The upstream's `readOnlyHint`, used by the member read-only default. */
  readOnly: boolean;
  /** Why the upstream's description looked like it targets the model (see security/untrusted.ts). */
  flags: string[];
}

export interface ToolIndex {
  tools: Tool[];
  routes: Map<string, Route>;
}

/**
 * Builds the gateway's tool list and its reverse routing map. Routing is
 * always a map lookup, never string parsing, because sanitised names can't be
 * reversed. Descriptions are prefixed with the server's name so a caller (or
 * an LLM) can see which server a tool really belongs to.
 */
export function buildToolIndex(upstreams: UpstreamTools[]): ToolIndex {
  const tools: Tool[] = [];
  const routes = new Map<string, Route>();
  for (const upstream of upstreams) {
    for (const raw of upstream.tools) {
      // Descriptions are third-party text: cleaned, bounded and flagged before
      // anyone (a client, the chat model, an approval prompt) reads them.
      const { tool, flags } = sanitizeTool(raw);
      let name = exposedToolName(upstream.slug, tool.name);
      // Two upstream names that sanitise to the same string (e.g. "a.b" and
      // "a_b"): the second one gets the hashed form instead.
      if (routes.has(name)) {
        name = exposedToolName(upstream.slug, `${tool.name}\u0000`);
      }
      routes.set(name, {
        slug: upstream.slug,
        upstreamName: tool.name,
        readOnly: tool.annotations?.readOnlyHint === true,
        flags,
      });
      tools.push({
        ...tool,
        name,
        description: `[${upstream.name}] ${tool.description ?? ""}`.trim(),
      });
    }
  }
  return { tools, routes };
}
