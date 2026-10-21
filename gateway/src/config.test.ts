import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { generateApiKey } from "./crypto/apiKeys.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
};

describe("loadConfig", () => {
  it("applies defaults and leaves seeding off", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.healthIntervalMs).toBe(15_000);
    expect(config.listTimeoutMs).toBe(5_000);
    expect(config.bootstrapAdmin).toBeUndefined();
    expect(config.seedWoocommerce).toBeUndefined();
  });

  it("reads bootstrap admin and WooCommerce seed settings", () => {
    const { key } = generateApiKey();
    const config = loadConfig({
      ...base,
      BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
      BOOTSTRAP_ADMIN_API_KEY: key,
      SEED_WOOCOMMERCE_URL: "http://mcp.urumi.svc.cluster.local:3000/mcp",
      SEED_WOOCOMMERCE_TOKEN: "t".repeat(64),
    });
    expect(config.bootstrapAdmin).toEqual({
      email: "admin@example.com",
      apiKey: key,
      password: undefined,
    });
    expect(config.seedWoocommerce?.url).toContain("/mcp");
  });

  it("lists every problem in one error", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "mysql://nope",
        BOOTSTRAP_ADMIN_PASSWORD: "short",
        BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow(/DATABASE_URL[\s\S]*BOOTSTRAP_ADMIN_PASSWORD[\s\S]*BOOTSTRAP_ADMIN_API_KEY/);
  });

  it("rejects a bootstrap key that isn't a gateway key", () => {
    expect(() =>
      loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_API_KEY: "secret" }),
    ).toThrow(/mgw_/);
  });

  it("treats empty strings as unset (optional Secret keys)", () => {
    const config = loadConfig({ ...base, SEED_WOOCOMMERCE_URL: "", SEED_WOOCOMMERCE_TOKEN: "" });
    expect(config.seedWoocommerce).toBeUndefined();
  });

  it("defaults the dashboard auth settings safely", () => {
    const { auth, trustProxyHops } = loadConfig(base);
    expect(auth).toEqual({
      dashboardUrl: undefined,
      publicMcpUrl: undefined,
      allowedOrigins: [], // no cookie-authenticated changes until an origin is configured
      cookieSecure: false,
      sessionTtlMs: 7 * 24 * 3_600_000,
      inviteTtlMs: 7 * 24 * 3_600_000,
    });
    expect(trustProxyHops).toBe(1);
  });

  it("derives the allowed origin from DASHBOARD_URL, or takes an explicit list", () => {
    const derived = loadConfig({ ...base, DASHBOARD_URL: "https://dash.example.com/" });
    expect(derived.auth.dashboardUrl).toBe("https://dash.example.com");
    expect(derived.auth.allowedOrigins).toEqual(["https://dash.example.com"]);

    const explicit = loadConfig({
      ...base,
      DASHBOARD_URL: "https://dash.example.com",
      DASHBOARD_ORIGINS: "http://localhost:5173, https://dash.example.com/app",
    });
    expect(explicit.auth.allowedOrigins).toEqual([
      "http://localhost:5173",
      "https://dash.example.com",
    ]);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["", false],
  ])("COOKIE_SECURE=%j -> %s", (value, expected) => {
    expect(loadConfig({ ...base, COOKIE_SECURE: value }).auth.cookieSecure).toBe(expected);
  });

  it.each([
    [undefined, true],
    ["", true],
    ["true", true],
    ["false", false],
  ])("METRICS_ENABLED=%j -> %s", (value, expected) => {
    expect(loadConfig({ ...base, METRICS_ENABLED: value }).metricsEnabled).toBe(expected);
  });

  it("rejects a non-boolean METRICS_ENABLED", () => {
    expect(() => loadConfig({ ...base, METRICS_ENABLED: "yes" })).toThrow(/METRICS_ENABLED/);
  });

  it.each([
    [undefined, "off"],
    ["", "off"],
    ["off", "off"],
    ["on", "on"],
    ["auto", "auto"],
  ])("SEARCH_MODE=%j -> %s", (value, expected) => {
    expect(loadConfig({ ...base, SEARCH_MODE: value }).searchMode).toBe(expected);
  });

  it.each([
    [undefined, "readOnly"],
    ["", "readOnly"],
    ["readOnly", "readOnly"],
    ["allowAll", "allowAll"],
  ])("MEMBER_DEFAULT_POLICY=%j -> %s", (value, expected) => {
    expect(loadConfig({ ...base, MEMBER_DEFAULT_POLICY: value }).memberDefault).toBe(expected);
  });

  it("rejects an unknown member default", () => {
    expect(() => loadConfig({ ...base, MEMBER_DEFAULT_POLICY: "everything" })).toThrow(
      /MEMBER_DEFAULT_POLICY/,
    );
  });

  describe("chat providers", () => {
    it("is off with no provider key", () => {
      expect(loadConfig(base).chat).toBeUndefined();
    });

    it("defaults to Groq's gpt-oss-120b with low reasoning effort", () => {
      const chat = loadConfig({ ...base, GROQ_API_KEY: "gsk" }).chat!;
      expect(chat.provider).toBe("groq");
      expect(chat.providers).toEqual([
        {
          id: "groq",
          apiKey: "gsk",
          model: "openai/gpt-oss-120b",
          baseUrl: undefined,
          reasoningEffort: "low",
          // Groq's free tier is ~8000 tokens/minute: smaller results, longer waits.
          limits: { maxResultChars: 4000, maxRetryWaitMs: 20_000 },
        },
      ]);
    });

    it("lets the user switch when both keys exist, with Groq the default", () => {
      const chat = loadConfig({ ...base, GROQ_API_KEY: "gsk", GEMINI_API_KEY: "gem" }).chat!;
      expect(chat.provider).toBe("groq");
      expect(chat.providers.map((p) => p.id)).toEqual(["groq", "gemini"]);
    });

    it("CHAT_PROVIDER=gemini makes Gemini the default but keeps Groq selectable", () => {
      const chat = loadConfig({
        ...base,
        GROQ_API_KEY: "gsk",
        GEMINI_API_KEY: "gem",
        CHAT_PROVIDER: "gemini",
      }).chat!;
      expect(chat.provider).toBe("gemini");
      expect(chat.providers.map((p) => p.id)).toEqual(["groq", "gemini"]);
    });

    it("falls back to the provider that has a key", () => {
      expect(loadConfig({ ...base, GEMINI_API_KEY: "gem" }).chat?.provider).toBe("gemini");
      expect(
        loadConfig({ ...base, GROQ_API_KEY: "gsk", CHAT_PROVIDER: "gemini" }).chat?.provider,
      ).toBe("groq");
    });

    it("reads the Groq model and reasoning effort, and lets effort be turned off", () => {
      const chat = loadConfig({
        ...base,
        GROQ_API_KEY: "gsk",
        GROQ_MODEL: "llama-3.3-70b-versatile",
        GROQ_REASONING_EFFORT: "",
      }).chat!;
      expect(chat.providers[0]).toMatchObject({
        model: "llama-3.3-70b-versatile",
        reasoningEffort: undefined,
      });
    });

    it("rejects an unknown provider or effort", () => {
      expect(() => loadConfig({ ...base, CHAT_PROVIDER: "openai" })).toThrow(/CHAT_PROVIDER/);
      expect(() => loadConfig({ ...base, GROQ_REASONING_EFFORT: "max" })).toThrow(
        /GROQ_REASONING_EFFORT/,
      );
    });
  });

  it("reads the auto threshold and the chat's own search mode", () => {
    const config = loadConfig({
      ...base,
      SEARCH_MODE: "auto",
      SEARCH_AUTO_THRESHOLD: "120",
      GEMINI_API_KEY: "k",
      CHAT_SEARCH_MODE: "on",
    });
    expect(config.searchMode).toBe("auto");
    expect(config.searchAutoThreshold).toBe(120);
    expect(config.chat?.searchMode).toBe("on");
    expect(loadConfig({ ...base, GEMINI_API_KEY: "k" }).chat?.searchMode).toBe("off");
    expect(loadConfig(base).searchAutoThreshold).toBe(50);
  });

  it.each([
    ["SEARCH_MODE", "always"],
    ["CHAT_SEARCH_MODE", "yes"],
    ["SEARCH_AUTO_THRESHOLD", "0"],
  ])("rejects a bad %s", (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow(new RegExp(key));
  });

  it("rejects a non-boolean COOKIE_SECURE and bad dashboard URLs", () => {
    expect(() => loadConfig({ ...base, COOKIE_SECURE: "yes" })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, DASHBOARD_URL: "javascript:alert(1)" })).toThrow(
      /DASHBOARD_URL/,
    );
    expect(() => loadConfig({ ...base, DASHBOARD_ORIGINS: "not a url" })).toThrow(
      /DASHBOARD_ORIGINS/,
    );
  });

  it("reads the bootstrap admin password, which must be long enough and needs the email", () => {
    const { key } = generateApiKey();
    const admin = { BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_API_KEY: key };
    expect(
      loadConfig({ ...base, ...admin, BOOTSTRAP_ADMIN_PASSWORD: "p".repeat(20) }).bootstrapAdmin
        ?.password,
    ).toBe("p".repeat(20));
    expect(() => loadConfig({ ...base, ...admin, BOOTSTRAP_ADMIN_PASSWORD: "short" })).toThrow(
      /BOOTSTRAP_ADMIN_PASSWORD/,
    );
    expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_PASSWORD: "p".repeat(20) })).toThrow(
      /needs BOOTSTRAP_ADMIN_EMAIL/,
    );
  });

  describe("oauth", () => {
    const on = { ...base, OAUTH_ENABLED: "true", DASHBOARD_URL: "https://dash.example.com/" };

    it("is off by default", () => {
      expect(loadConfig(base).oauth).toBeUndefined();
    });

    it("takes the issuer from PUBLIC_BASE_URL; the resource is its /mcp", () => {
      expect(loadConfig({ ...on, PUBLIC_BASE_URL: "https://gw.example.com/" }).oauth).toEqual({
        issuer: "https://gw.example.com",
        resource: "https://gw.example.com/mcp",
        consentUrl: "https://dash.example.com/oauth/consent",
        accessTtlMs: 3_600_000,
        refreshTtlMs: 30 * 86_400_000,
        codeTtlMs: 600_000,
      });
    });

    it("falls back to PUBLIC_MCP_URL's origin, and reads the lifetimes", () => {
      const oauth = loadConfig({
        ...on,
        PUBLIC_MCP_URL: "http://gateway.local.test/mcp",
        OAUTH_ACCESS_TTL_MINUTES: "15",
        OAUTH_REFRESH_TTL_DAYS: "7",
      }).oauth;
      expect(oauth).toMatchObject({
        issuer: "http://gateway.local.test",
        resource: "http://gateway.local.test/mcp",
        accessTtlMs: 15 * 60_000,
        refreshTtlMs: 7 * 86_400_000,
      });
    });

    it("needs an issuer and the dashboard, and sane lifetimes", () => {
      expect(() => loadConfig(on)).toThrow(/needs PUBLIC_BASE_URL/);
      expect(() =>
        loadConfig({ ...base, OAUTH_ENABLED: "true", PUBLIC_BASE_URL: "https://gw.example.com" }),
      ).toThrow(/needs DASHBOARD_URL/);
      expect(() => loadConfig({ ...on, PUBLIC_BASE_URL: "ftp://gw.example.com" })).toThrow(
        /PUBLIC_BASE_URL/,
      );
      expect(() =>
        loadConfig({
          ...on,
          PUBLIC_BASE_URL: "https://gw.example.com",
          OAUTH_REFRESH_TTL_DAYS: "0",
        }),
      ).toThrow(/OAUTH_REFRESH_TTL_DAYS/);
    });
  });
});
