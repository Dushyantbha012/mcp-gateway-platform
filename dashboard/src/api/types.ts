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
  "success" | "tool_error" | "timeout" | "unreachable" | "rejected" | "denied" | "held";
export type AuditSource = "mcp" | "chat" | "dashboard";

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
  /** Set when the provisioner owns this server; it can't be edited here. */
  managedBy: "store" | "hosted" | null;
  tools: ServerTool[];
  createdAt: string;
  updatedAt: string;
}

export type StoreStatus = "provisioning" | "ready" | "failed" | "deleting";

/** storeView in gateway/src/api/stores.ts. */
export interface Store {
  id: string;
  slug: string;
  name: string;
  /** "default" = the store installed by Helm; it can't be deleted here. */
  kind: "default" | "provisioned";
  status: StoreStatus;
  /** Where provisioning is (or stopped). */
  step: string | null;
  /** What it's waiting on, or why it failed. */
  reason: string | null;
  url: string | null;
  namespace: string | null;
  serverId: string | null;
  owner: { id: string; email: string | null } | null;
  /** The caller may delete / retry it. */
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoreList {
  enabled: boolean;
  maxPerUser: number;
  stores: Store[];
}

export type HostedTransport = "http" | "stdio";

/** hostedView in gateway/src/api/hosted.ts. Secret variables appear by name only. */
export interface Hosted {
  id: string;
  slug: string;
  name: string;
  image: string;
  transport: HostedTransport;
  /** stdio: what the bridge runs in place of the image's entrypoint. */
  command: string[];
  port: number;
  path: string;
  libc: "glibc" | "musl";
  env: Record<string, string>;
  secretEnvKeys: string[];
  /** http only: the variable the image reads its generated bearer token from. */
  authTokenEnv: string | null;
  egress: "none" | "internet";
  size: "small" | "medium";
  status: StoreStatus;
  step: string | null;
  reason: string | null;
  namespace: string | null;
  /** Its mcp_servers row once registered (the same id). */
  serverId: string | null;
  createdBy: { id: string; email: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedList {
  enabled: boolean;
  imageAllowlist: string[];
  servers: Hosted[];
}

/**
 * Create or update body. On update `secretEnv` merges: a value sets that
 * variable, null removes it, unmentioned ones keep their stored value.
 */
export interface HostedInput {
  slug?: string;
  name: string;
  image: string;
  transport?: HostedTransport;
  command: string[];
  port: number;
  path: string;
  libc: Hosted["libc"];
  env: Record<string, string>;
  secretEnv: Record<string, string | null>;
  authTokenEnv: string | null;
  egress: Hosted["egress"];
  size: Hosted["size"];
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

/** A write an MCP client asked for, waiting for its user. */
export interface WriteApproval {
  id: string;
  name: string;
  args: unknown;
  tool: (ToolHints & { server: string }) | null;
  createdAt: string;
  expiresAt: string;
}

/** What an upstream says about a tool, shown on approval prompts. */
export interface ToolHints {
  description: string;
  destructive?: boolean;
  idempotent?: boolean;
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
  /** The X-Request-ID of the request that made the call; null for older rows. */
  requestId: string | null;
  /** Non-error context, e.g. the query of a search_tools call. */
  detail?: string | null;
}

export interface AuditFilters {
  userId?: string;
  server?: string;
  outcome?: AuditOutcome;
  source?: AuditSource;
  requestId?: string;
}

export interface ChatProvider {
  id: string;
  model: string;
}

export interface Meta {
  mcpUrl: string | null;
  chatEnabled: boolean;
  /** The models a user can switch between in the chat, and the default one's id. */
  chatProviders?: ChatProvider[];
  chatProvider?: string | null;
  /** How MCP clients get tools by default: all of them, or search_tools + call_tool. */
  searchMode?: "off" | "on" | "auto";
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
  /** A tool that changes data, held until the user approves it; the turn ends after it. */
  | {
      type: "confirm";
      id: string;
      name: string;
      server: string | null;
      args: unknown;
      info?: ToolHints;
    }
  | { type: "text"; text: string }
  | { type: "done"; steps: number }
  | { type: "error"; code: string; message: string };

export type RuleEffect = "allow" | "deny";

export type RuleSubject =
  { type: "role"; role: Role } | { type: "user"; userId: string; email?: string; name?: string };

export interface PermissionRule {
  id: string;
  subject: RuleSubject;
  serverSlug: string;
  /** The upstream's own tool name; null = the whole server. */
  toolName: string | null;
  effect: RuleEffect;
  createdAt: string;
}

/** Who a rule is being edited for: the Members role, or one person. */
export type PermissionSubject = { role: "member" } | { userId: string };

export interface EffectiveTool {
  name: string;
  serverSlug: string;
  toolName: string;
  allowed: boolean;
  reason: "admin" | "default" | "rule" | "read-only-default";
  rule?: { subjectType: "role" | "user"; toolName: string | null; effect: RuleEffect };
}

export type StatsRange = "24h" | "7d" | "30d";

/** GET /api/stats (admin only): aggregates over the audit log. */
export interface Stats {
  range: StatsRange;
  bucket: "hour" | "day";
  totals: { total: number; errors: number; avgMs: number; p95Ms: number };
  previous: { total: number; errors: number };
  byOutcome: { outcome: AuditOutcome; count: number }[];
  series: { bucket: string; success: number; errors: number }[];
  topTools: { tool: string; server: string | null; count: number }[];
  topServers: { server: string; count: number }[];
}
