/**
 * Response shapes of the gateway's REST API. Hand-written mirrors of the
 * views in gateway/src/api/*.ts (serverView, userView, keyView, the audit
 * row) - the gateway never returns credentials, hashes or tokens, so
 * neither do these types.
 */

export type Role = "admin" | "member";
export type AuthType = "none" | "bearer" | "header";
export type ServerStatus = "connected" | "unreachable" | "disabled" | "unknown";
export type AuditOutcome =
  "success" | "tool_error" | "timeout" | "unreachable" | "rejected" | "denied";
export type AuditSource = "mcp" | "chat";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  disabledAt: string | null;
  hasPassword: boolean;
}

export interface Invite {
  inviteUrl: string;
  inviteExpiresAt: string;
}

export interface ServerTool {
  /** As MCP clients see it: `<slug>__<tool>`. */
  name: string;
  upstreamName: string;
  description?: string;
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  /** Admins only. */
  url?: string;
  enabled: boolean;
  status: ServerStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  authType: AuthType;
  authHeaderName: string | null;
  hasCredential: boolean;
  timeoutMs: number;
  tools: ServerTool[];
  createdAt: string;
  updatedAt: string;
}

export interface ServerInput {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName?: string | null;
  /** Write-only. Omitted on edit = keep the stored one. */
  credential?: string;
  timeoutMs: number;
  enabled?: boolean;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewApiKey extends ApiKey {
  /** The only time the plaintext key is ever returned. */
  key: string;
}

/** An MCP tool as tools/list returns it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface AuditEntry {
  id: string;
  ts: string;
  userId: string | null;
  userEmail: string;
  apiKeyId: string | null;
  source: AuditSource;
  server: string | null;
  tool: string;
  durationMs: number;
  outcome: AuditOutcome;
  error: string | null;
}

export interface AuditFilters {
  userId?: string;
  server?: string;
  outcome?: AuditOutcome;
  source?: AuditSource;
}

export interface Meta {
  mcpUrl: string | null;
  chatEnabled: boolean;
}

/** One message sent to the chat endpoint; history lives in the browser. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** Events the gateway streams for one chat turn. */
export type ChatEvent =
  | { type: "tool_call"; id: string; name: string; server: string | null; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      isError: boolean;
      summary: string;
      durationMs: number;
    }
  | { type: "text"; text: string }
  | { type: "done"; steps: number }
  | { type: "error"; code: string; message: string };
