import { z } from "zod";
import { looksLikeApiKey } from "./crypto/apiKeys.js";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    DATABASE_URL: z.string().startsWith("postgres"),
    // 32 random bytes, base64 - from the gateway-encryption-key Secret.
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
    HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    LIST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    MAX_RESULT_BYTES: z.coerce.number().int().positive().default(1_000_000),
    // Seeded on startup when present. Both come from k8s Secrets.
    BOOTSTRAP_ADMIN_EMAIL: optionalString.pipe(z.email().optional()),
    BOOTSTRAP_ADMIN_API_KEY: optionalString.refine(
      (v) => v === undefined || looksLikeApiKey(v),
      "must be a gateway API key (mgw_...)",
    ),
    SEED_WOOCOMMERCE_URL: optionalString.pipe(z.url().optional()),
    SEED_WOOCOMMERCE_TOKEN: optionalString,
  })
  .refine((e) => !!e.BOOTSTRAP_ADMIN_EMAIL === !!e.BOOTSTRAP_ADMIN_API_KEY, {
    message: "set both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_API_KEY, or neither",
    path: ["BOOTSTRAP_ADMIN_API_KEY"],
  })
  .refine((e) => !!e.SEED_WOOCOMMERCE_URL === !!e.SEED_WOOCOMMERCE_TOKEN, {
    message: "set both SEED_WOOCOMMERCE_URL and SEED_WOOCOMMERCE_TOKEN, or neither",
    path: ["SEED_WOOCOMMERCE_TOKEN"],
  });

export interface Config {
  port: number;
  databaseUrl: string;
  encryptionKey: string;
  healthIntervalMs: number;
  listTimeoutMs: number;
  maxResultBytes: number;
  bootstrapAdmin?: { email: string; apiKey: string };
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
    encryptionKey: e.ENCRYPTION_KEY,
    healthIntervalMs: e.HEALTH_INTERVAL_MS,
    listTimeoutMs: e.LIST_TIMEOUT_MS,
    maxResultBytes: e.MAX_RESULT_BYTES,
    bootstrapAdmin:
      e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_API_KEY
        ? { email: e.BOOTSTRAP_ADMIN_EMAIL, apiKey: e.BOOTSTRAP_ADMIN_API_KEY }
        : undefined,
    seedWoocommerce:
      e.SEED_WOOCOMMERCE_URL && e.SEED_WOOCOMMERCE_TOKEN
        ? { url: e.SEED_WOOCOMMERCE_URL, token: e.SEED_WOOCOMMERCE_TOKEN }
        : undefined,
  };
}
