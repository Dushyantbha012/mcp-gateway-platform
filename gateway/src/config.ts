import { z } from "zod";
import { looksLikeApiKey } from "./crypto/apiKeys.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./crypto/passwords.js";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

// z.coerce.boolean() would turn the string "false" into true.
const envBoolean = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v === "true");

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
    // Chat agent. Without a key the chat endpoint answers 503 and everything
    // else works as before. The key comes from a k8s Secret.
    GEMINI_API_KEY: optionalString,
    // Free-tier Flash models allow ~20 requests a day; Flash Lite allows 500.
    GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
    GEMINI_BASE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    CHAT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
    CHAT_TURN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(90_000),
    // Chat turns one user may start per minute (each turn costs several LLM requests).
    CHAT_TURNS_PER_MINUTE: z.coerce.number().int().min(1).default(6),
    // Reverse proxies (Traefik) in front of the gateway, for the client IP
    // used by the login rate limit.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
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

export interface ChatConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxSteps: number;
  turnTimeoutMs: number;
  turnsPerMinute: number;
}

export interface Config {
  port: number;
  databaseUrl: string;
  healthIntervalMs: number;
  listTimeoutMs: number;
  maxResultBytes: number;
  trustProxyHops: number;
  ssrfAllowedHosts: string[];
  upstreamSecretsNamespace?: string;
  auth: AuthConfig;
  /** Undefined when no GEMINI_API_KEY is set: chat is switched off. */
  chat?: ChatConfig;
  bootstrapAdmin?: { email: string; apiKey: string; password?: string };
  seedWoocommerce?: { url: string; token: string };
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
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    healthIntervalMs: e.HEALTH_INTERVAL_MS,
    listTimeoutMs: e.LIST_TIMEOUT_MS,
    maxResultBytes: e.MAX_RESULT_BYTES,
    trustProxyHops: e.TRUST_PROXY_HOPS,
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
    chat: e.GEMINI_API_KEY
      ? {
          apiKey: e.GEMINI_API_KEY,
          model: e.GEMINI_MODEL,
          baseUrl: e.GEMINI_BASE_URL,
          maxSteps: e.CHAT_MAX_STEPS,
          turnTimeoutMs: e.CHAT_TURN_TIMEOUT_MS,
          turnsPerMinute: e.CHAT_TURNS_PER_MINUTE,
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
    seedWoocommerce:
      e.SEED_WOOCOMMERCE_URL && e.SEED_WOOCOMMERCE_TOKEN
        ? { url: e.SEED_WOOCOMMERCE_URL, token: e.SEED_WOOCOMMERCE_TOKEN }
        : undefined,
  };
}
