import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Kysely table types; must match migrations/. */

type CreatedAt = ColumnType<Date, Date | undefined, never>;

export type Role = "admin" | "member";
export type AuthType = "none" | "bearer" | "header";
export type ServerStatus = "connected" | "unreachable" | "unknown";
export type AuditOutcome =
  "success" | "tool_error" | "timeout" | "unreachable" | "rejected" | "denied";
export type AuditSource = "mcp" | "chat";

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  role: Role;
  created_at: CreatedAt;
  disabled_at: Date | null;
  password_hash: string | null;
}

export interface ApiKeysTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: Buffer;
  created_at: CreatedAt;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** Cached tools/list result for one upstream (MCP Tool objects, unmodified). */
export type ToolsCache = ColumnType<unknown[] | null, string | null, string | null>;

export interface McpServersTable {
  id: Generated<string>;
  slug: string;
  name: string;
  url: string;
  enabled: Generated<boolean>;
  auth_type: Generated<AuthType>;
  auth_header_name: string | null;
  /** Whether the credential store (a Kubernetes Secret) holds a value for this server. */
  has_credential: Generated<boolean>;
  timeout_ms: Generated<number>;
  status: Generated<ServerStatus>;
  last_error: string | null;
  last_checked_at: Date | null;
  tools_cache: ToolsCache;
  tools_cached_at: Date | null;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<string>;
  ts: Generated<Date>;
  user_id: string | null;
  user_email: string;
  api_key_id: string | null;
  source: AuditSource;
  server_slug: string | null;
  tool_name: string;
  duration_ms: number;
  outcome: AuditOutcome;
  error: string | null;
  /** The `X-Request-ID` of the request that made the call; null for older rows. */
  request_id: string | null;
  /** Context that isn't an error, e.g. the query of a `search_tools` call. */
  detail: string | null;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Buffer;
  created_at: CreatedAt;
  last_seen_at: Generated<Date>;
  expires_at: Date;
}

export interface InvitesTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Buffer;
  created_by: string | null;
  created_at: CreatedAt;
  expires_at: Date;
  used_at: Date | null;
}

export interface ToolPermissionsTable {
  id: Generated<string>;
  role: Role | null;
  user_id: string | null;
  server_slug: string;
  /** Upstream's own tool name; null = every tool of the server. */
  tool_name: string | null;
  effect: "allow" | "deny";
  created_by: string | null;
  created_at: CreatedAt;
}

export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  mcp_servers: McpServersTable;
  audit_log: AuditLogTable;
  sessions: SessionsTable;
  invites: InvitesTable;
  tool_permissions: ToolPermissionsTable;
}

export type User = Selectable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type ApiKey = Selectable<ApiKeysTable>;
export type McpServer = Selectable<McpServersTable>;
export type NewMcpServer = Insertable<McpServersTable>;
export type McpServerUpdate = Updateable<McpServersTable>;
export type ToolPermissionRow = Selectable<ToolPermissionsTable>;
export type AuditEntry = Selectable<AuditLogTable>;
export type NewAuditEntry = Insertable<AuditLogTable>;
