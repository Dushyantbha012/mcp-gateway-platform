import { describe, expect, it } from "vitest";
import { defaultsFor, serverFormSchema, toInput, type ServerFormValues } from "./serverForm";
import { serverFixture } from "@/test/server";

const valid: ServerFormValues = {
  slug: "github",
  name: "GitHub",
  url: "https://api.githubcopilot.com/mcp/",
  authType: "bearer",
  authHeaderName: "",
  credential: "ghp_x",
  timeoutMs: 10_000,
};

const errorsFor = (values: Partial<ServerFormValues>, hasStoredCredential = false) => {
  const result = serverFormSchema({ hasStoredCredential }).safeParse({ ...valid, ...values });
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("server form validation (mirrors the gateway)", () => {
  it("accepts a valid server", () => {
    expect(errorsFor({})).toEqual({});
  });

  it.each(["Bad", "has_underscore", "a", "1abc", "x".repeat(32), ""])("rejects slug %j", (slug) => {
    expect(errorsFor({ slug })).toHaveProperty("slug");
  });

  it.each(["ok", "my-server-2", "a1"])("accepts slug %j", (slug) => {
    expect(errorsFor({ slug })).toEqual({});
  });

  it.each(["not a url", "ftp://x.test/mcp", "javascript:alert(1)", "file:///etc/passwd"])(
    "rejects url %j",
    (url) => {
      expect(errorsFor({ url })).toHaveProperty("url");
    },
  );

  it.each([99, 120_001, 1.5, Number.NaN])("rejects timeout %s", (timeoutMs) => {
    expect(errorsFor({ timeoutMs })).toHaveProperty("timeoutMs");
  });

  it("requires a credential for bearer/header on create", () => {
    expect(errorsFor({ credential: "" })).toHaveProperty("credential");
    expect(
      errorsFor({ authType: "header", authHeaderName: "X-Key", credential: "" }),
    ).toHaveProperty("credential");
    expect(errorsFor({ authType: "none", credential: "" })).toEqual({});
  });

  it("on edit, a blank credential keeps the stored one", () => {
    expect(errorsFor({ credential: "" }, true)).toEqual({});
  });

  it("requires a valid, non-reserved header name for header auth", () => {
    expect(errorsFor({ authType: "header", authHeaderName: "" })).toHaveProperty("authHeaderName");
    expect(errorsFor({ authType: "header", authHeaderName: "Bad Header" })).toHaveProperty(
      "authHeaderName",
    );
    expect(errorsFor({ authType: "header", authHeaderName: "Mcp-Session-Id" })).toEqual({
      authHeaderName: "Reserved by the MCP transport",
    });
    expect(errorsFor({ authType: "header", authHeaderName: "X-API-Key" })).toEqual({});
  });
});

describe("toInput", () => {
  it("sends the credential only when typed, and the header name only for header auth", () => {
    expect(toInput({ ...valid, credential: "" })).not.toHaveProperty("credential");
    expect(toInput(valid)).toMatchObject({ authType: "bearer", credential: "ghp_x" });
    expect(toInput(valid)).not.toHaveProperty("authHeaderName");
    expect(toInput({ ...valid, authType: "header", authHeaderName: "X-Key" })).toMatchObject({
      authHeaderName: "X-Key",
    });
    expect(toInput({ ...valid, authType: "none" })).not.toHaveProperty("credential");
  });

  it("trims the name", () => {
    expect(toInput({ ...valid, name: "  GitHub  " }).name).toBe("GitHub");
  });
});

describe("defaultsFor", () => {
  it("never prefills the credential when editing", () => {
    const values = defaultsFor(serverFixture({ hasCredential: true }));
    expect(values.credential).toBe("");
    expect(values.slug).toBe("woocommerce");
  });
});
