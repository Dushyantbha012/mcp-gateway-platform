import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Where requests are sent: the in-cluster WordPress Service.
  WC_BASE_URL: z.url(),
  // The store's public home URL (WP_HOME). WooCommerce builds the OAuth
  // signature base string from its own home URL, not from the Host the
  // request arrived on, so we must sign with this. Defaults to WC_BASE_URL.
  WC_SIGNING_URL: z.url().optional(),
  WC_CONSUMER_KEY: z.string().startsWith("ck_"),
  WC_CONSUMER_SECRET: z.string().startsWith("cs_"),
  WC_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  MCP_AUTH_TOKEN: z.string().min(16, "MCP_AUTH_TOKEN must be at least 16 characters"),
});

export interface Config {
  port: number;
  wc: {
    baseUrl: string;
    signingUrl: string;
    consumerKey: string;
    consumerSecret: string;
    timeoutMs: number;
  };
  authToken: string;
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
  const trim = (url: string) => url.replace(/\/+$/, "");
  return {
    port: e.PORT,
    wc: {
      baseUrl: trim(e.WC_BASE_URL),
      signingUrl: trim(e.WC_SIGNING_URL ?? e.WC_BASE_URL),
      consumerKey: e.WC_CONSUMER_KEY,
      consumerSecret: e.WC_CONSUMER_SECRET,
      timeoutMs: e.WC_TIMEOUT_MS,
    },
    authToken: e.MCP_AUTH_TOKEN,
  };
}
