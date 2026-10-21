import { z } from "zod";
import { looksLikeApiKey } from "./crypto/apiKeys.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./crypto/passwords.js";
import type { MemberDefault } from "./permissions/evaluate.js";
import type { SearchMode } from "./search/surface.js";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

// z.coerce.boolean() would turn the string "false" into true.
const envBoolean = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v === "true");

/** Like envBoolean, but on unless explicitly "false". */
const envBooleanDefaultOn = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v !== "false");

const searchMode = z
  .enum(["off", "on", "auto", ""])
  .optional()
  .transform((v) => (v === undefined || v === "" ? "off" : v));

const memberDefault = z
  .enum(["readOnly", "allowAll", ""])
  .optional()
  .transform((v) => (v === undefined || v === "" ? "readOnly" : v));

const commaList = optionalString.transform((v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    DATABASE_URL: z.string().startsWith("postgres"),
    HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    LIST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    MAX_RESULT_BYTES: z.coerce.number().int().positive().default(1_000_000),
    // Seeded on startup when present. Both come from k8s Secrets.
    BOOTSTRAP_ADMIN_EMAIL: optionalString.pipe(z.email().optional()),
    BOOTSTRAP_ADMIN_API_KEY: optionalString.refine(
      (v) => v === undefined || looksLikeApiKey(v),
      "must be a gateway API key (mgw_...)",
    ),
    BOOTSTRAP_ADMIN_PASSWORD: optionalString.pipe(
      z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).optional(),
    ),
    // Hostnames that may resolve to private addresses despite the SSRF guard
    // (exact match). The seeded WooCommerce host is added automatically.
    SSRF_ALLOWED_HOSTS: commaList,
    // Namespace whose Secrets hold the upstream credentials. Unset = keep them
    // in memory (tests, running outside Kubernetes); they are lost on restart.
    UPSTREAM_SECRETS_NAMESPACE: optionalString.pipe(
      z
        .string()
        .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
        .optional(),
    ),
    SEED_WOOCOMMERCE_URL: optionalString.pipe(z.url().optional()),
    SEED_WOOCOMMERCE_TOKEN: optionalString,
    // Public storefront URL of the seeded store, shown on the Stores page.
    // Multi-store: users create stores from the dashboard; a separate
    // provisioner pod builds them. Off = the Stores page is read-only.
    STORES_ENABLED: envBoolean,
    STORES_MAX_PER_USER: z.coerce.number().int().min(0).max(20).default(2),
    STORES_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(900),
    SEED_STORE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    // Public URLs, from Helm values. DASHBOARD_URL builds invite links;
    // PUBLIC_MCP_URL is shown to members as "point your MCP client here".
    DASHBOARD_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    PUBLIC_MCP_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    // Origins allowed to make cookie-authenticated changes (CSRF defence).
    // Defaults to DASHBOARD_URL's origin.
    DASHBOARD_ORIGINS: commaList.pipe(z.array(z.url({ protocol: /^https?$/ }))),
    COOKIE_SECURE: envBoolean,
    SESSION_TTL_HOURS: z.coerce
      .number()
      .positive()
      .max(24 * 90)
      .default(24 * 7),
    INVITE_TTL_HOURS: z.coerce
      .number()
      .positive()
      .max(24 * 30)
      .default(24 * 7),
    // Chat agent. Without any provider key the chat endpoint answers 503 and
    // everything else works as before. Keys come from k8s Secrets.
    // CHAT_PROVIDER picks the default; users can switch to any other provider
    // that has a key. Default groq (falls back to the other if only it has a key).
    CHAT_PROVIDER: z
      .enum(["groq", "gemini", ""])
      .optional()
      .transform((v) => (v === undefined || v === "" ? "groq" : v)),
    GROQ_API_KEY: optionalString,
    GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
    GROQ_BASE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    // gpt-oss only: low | medium | high ("" = don't send). Low is fastest and cheapest.
    // Groq's free tier allows ~8000 tokens a minute, so a big tool result can use it all:
    // results fed back to the model are cut to this many characters (~4 per token).
    GROQ_MAX_RESULT_CHARS: z.coerce.number().int().min(500).default(4000),
    GROQ_REASONING_EFFORT: z
      .enum(["low", "medium", "high", ""])
      .optional()
      .transform((v) => (v === undefined ? "low" : v)),
    GEMINI_API_KEY: optionalString,
    // Free-tier Flash models allow ~20 requests a day; Flash Lite allows 500.
    GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
    GEMINI_BASE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    CHAT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
    CHAT_TURN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(90_000),
    // Chat turns one user may start per minute (each turn costs several LLM requests).
    CHAT_TURNS_PER_MINUTE: z.coerce.number().int().min(1).default(6),
    // Hold chat tool calls that change data until the user approves them.
    CHAT_CONFIRM_WRITES: envBooleanDefaultOn,
    // Hold writes called by MCP clients until the user approves them in the dashboard.
    MCP_CONFIRM_WRITES: envBooleanDefaultOn,
    // Reverse proxies (Traefik) in front of the gateway, for the client IP
    // used by the login rate limit.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    // Serve Prometheus metrics at GET /metrics (unauthenticated; keep it off the Ingress).
    METRICS_ENABLED: envBooleanDefaultOn,
    // Search-then-execute: expose only search_tools + call_tool instead of
    // every tool. "auto" does so once a caller can see more than the threshold.
    // MCP clients can override per request with /mcp?mode=search|full.
    SEARCH_MODE: searchMode,
    SEARCH_AUTO_THRESHOLD: z.coerce.number().int().min(1).default(50),
    // The same choice for the chat agent's model.
    CHAT_SEARCH_MODE: searchMode,
    // What members may use when no permission rule matches: only tools the
    // upstream marks read-only (default), or everything.
    MEMBER_DEFAULT_POLICY: memberDefault,
  })
  .refine((e) => !!e.BOOTSTRAP_ADMIN_EMAIL === !!e.BOOTSTRAP_ADMIN_API_KEY, {
    message: "set both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_API_KEY, or neither",
    path: ["BOOTSTRAP_ADMIN_API_KEY"],
  })
  .refine((e) => !e.BOOTSTRAP_ADMIN_PASSWORD || !!e.BOOTSTRAP_ADMIN_EMAIL, {
    message: "BOOTSTRAP_ADMIN_PASSWORD needs BOOTSTRAP_ADMIN_EMAIL",
    path: ["BOOTSTRAP_ADMIN_PASSWORD"],
  })
  .refine((e) => !!e.SEED_WOOCOMMERCE_URL === !!e.SEED_WOOCOMMERCE_TOKEN, {
    message: "set both SEED_WOOCOMMERCE_URL and SEED_WOOCOMMERCE_TOKEN, or neither",
    path: ["SEED_WOOCOMMERCE_TOKEN"],
  });

/** What the dashboard login, sessions and invite links need. */
export interface AuthConfig {
  dashboardUrl?: string;
  publicMcpUrl?: string;
  /** Exact origins (scheme://host[:port]) allowed to send cookie-authenticated changes. */
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionTtlMs: number;
  inviteTtlMs: number;
}

export type ChatProviderId = "groq" | "gemini";

/** One model provider that has an API key. */
export interface ChatProviderConfig {
  id: ChatProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Groq gpt-oss only. */
  reasoningEffort?: string;
  /** Per-provider agent limits (smaller results and longer rate-limit waits on Groq). */
  limits?: { maxResultChars?: number; maxRetryWaitMs?: number };
}

export interface ChatConfig {
  /** The provider a chat uses unless the user picks another. Always one of `providers`. */
  provider: ChatProviderId;
  /** Every provider with an API key; the user may switch between them. */
  providers: ChatProviderConfig[];
  maxSteps: number;
  turnTimeoutMs: number;
  turnsPerMinute: number;
  searchMode: SearchMode;
  /** Writes wait for the user's approval. */
  confirmWrites: boolean;
}

export interface Config {
  port: number;
  databaseUrl: string;
  healthIntervalMs: number;
  listTimeoutMs: number;
  maxResultBytes: number;
  trustProxyHops: number;
  metricsEnabled: boolean;
  searchMode: SearchMode;
  memberDefault: MemberDefault;
  /** Writes from MCP clients wait for the user's approval in the dashboard. */
  mcpConfirmWrites: boolean;
  /** With searchMode "auto": meta-tools only above this many visible tools. */
  searchAutoThreshold: number;
  ssrfAllowedHosts: string[];
  upstreamSecretsNamespace?: string;
  auth: AuthConfig;
  /** Undefined when no provider has an API key: chat is switched off. */
  chat?: ChatConfig;
  bootstrapAdmin?: { email: string; apiKey: string; password?: string };
  seedWoocommerce?: { url: string; token: string; storeUrl?: string };
  stores: { enabled: boolean; maxPerUser: number; timeoutSeconds: number };
}

/** Parses and validates env; throws one readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = result.data;
  // Groq first, so it is the fallback default when CHAT_PROVIDER names a provider without a key.
  const chatProviders: ChatProviderConfig[] = [
    ...(e.GROQ_API_KEY
      ? [
          {
            id: "groq" as const,
            apiKey: e.GROQ_API_KEY,
            model: e.GROQ_MODEL,
            baseUrl: e.GROQ_BASE_URL,
            reasoningEffort: e.GROQ_REASONING_EFFORT || undefined,
            // A per-minute token cap clears within a minute: wait up to 20 s, twice, before failing.
            limits: { maxResultChars: e.GROQ_MAX_RESULT_CHARS, maxRetryWaitMs: 20_000 },
          },
        ]
      : []),
    ...(e.GEMINI_API_KEY
      ? [
          {
            id: "gemini" as const,
            apiKey: e.GEMINI_API_KEY,
            model: e.GEMINI_MODEL,
            baseUrl: e.GEMINI_BASE_URL,
          },
        ]
      : []),
  ];
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    healthIntervalMs: e.HEALTH_INTERVAL_MS,
    listTimeoutMs: e.LIST_TIMEOUT_MS,
    maxResultBytes: e.MAX_RESULT_BYTES,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    metricsEnabled: e.METRICS_ENABLED,
    searchMode: e.SEARCH_MODE,
    memberDefault: e.MEMBER_DEFAULT_POLICY,
    mcpConfirmWrites: e.MCP_CONFIRM_WRITES,
    searchAutoThreshold: e.SEARCH_AUTO_THRESHOLD,
    ssrfAllowedHosts: e.SSRF_ALLOWED_HOSTS,
    upstreamSecretsNamespace: e.UPSTREAM_SECRETS_NAMESPACE,
    auth: {
      dashboardUrl: e.DASHBOARD_URL?.replace(/\/+$/, ""),
      publicMcpUrl: e.PUBLIC_MCP_URL,
      allowedOrigins: (e.DASHBOARD_ORIGINS.length
        ? e.DASHBOARD_ORIGINS
        : e.DASHBOARD_URL
          ? [e.DASHBOARD_URL]
          : []
      ).map((u) => new URL(u).origin),
      cookieSecure: e.COOKIE_SECURE,
      sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
      inviteTtlMs: e.INVITE_TTL_HOURS * 3_600_000,
    },
    chat: chatProviders.length
      ? {
          provider: (chatProviders.find((p) => p.id === e.CHAT_PROVIDER) ?? chatProviders[0]!).id,
          providers: chatProviders,
          maxSteps: e.CHAT_MAX_STEPS,
          turnTimeoutMs: e.CHAT_TURN_TIMEOUT_MS,
          turnsPerMinute: e.CHAT_TURNS_PER_MINUTE,
          searchMode: e.CHAT_SEARCH_MODE,
          confirmWrites: e.CHAT_CONFIRM_WRITES,
        }
      : undefined,
    bootstrapAdmin:
      e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_API_KEY
        ? {
            email: e.BOOTSTRAP_ADMIN_EMAIL,
            apiKey: e.BOOTSTRAP_ADMIN_API_KEY,
            password: e.BOOTSTRAP_ADMIN_PASSWORD,
          }
        : undefined,
    stores: {
      enabled: e.STORES_ENABLED,
      maxPerUser: e.STORES_MAX_PER_USER,
      timeoutSeconds: e.STORES_TIMEOUT_SECONDS,
    },
    seedWoocommerce:
      e.SEED_WOOCOMMERCE_URL && e.SEED_WOOCOMMERCE_TOKEN
        ? {
            url: e.SEED_WOOCOMMERCE_URL,
            token: e.SEED_WOOCOMMERCE_TOKEN,
            storeUrl: e.SEED_STORE_URL,
          }
        : undefined,
  };
}
