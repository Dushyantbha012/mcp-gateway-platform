import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildToolIndex, exposedToolName, isValidSlug, MAX_TOOL_NAME, slugOf } from "./naming.js";

const tool = (name: string, description = `does ${name}`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

describe("slugs", () => {
  it.each(["woocommerce", "github", "store-2", "ab"])("accepts %s", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(["", "a", "Woo", "2store", "has_underscore", "has__double", "a b", "x".repeat(32)])(
    "rejects %j",
    (slug) => {
      expect(isValidSlug(slug)).toBe(false);
    },
  );
});

describe("exposedToolName", () => {
  it("uses slug__tool when the result is valid", () => {
    expect(exposedToolName("woocommerce", "list_orders")).toBe("woocommerce__list_orders");
  });

  it("splits on the first separator even when the tool name has its own __", () => {
    const name = exposedToolName("github", "repo__search");
    expect(name).toBe("github__repo__search");
    expect(slugOf(name)).toBe("github");
  });

  it("sanitises unsafe characters with a hash suffix", () => {
    const name = exposedToolName("docs", "resolve.library id");
    expect(name).toMatch(/^docs__resolve_library_id_[0-9a-f]{8}$/);
  });

  it("truncates long names to the 64-character limit, deterministically", () => {
    const long = "x".repeat(100);
    const a = exposedToolName("woocommerce", long);
    expect(a).toHaveLength(MAX_TOOL_NAME);
    expect(exposedToolName("woocommerce", long)).toBe(a);
    expect(exposedToolName("woocommerce", `${long}y`)).not.toBe(a);
  });

  it("returns null slug for names without a separator", () => {
    expect(slugOf("list_orders")).toBeNull();
    expect(slugOf("__x")).toBeNull();
  });
});

describe("buildToolIndex", () => {
  it("keeps same-named tools from two servers apart and routes each correctly", () => {
    const index = buildToolIndex([
      { slug: "store-a", name: "Store A", tools: [tool("list_products")] },
      { slug: "store-b", name: "Store B", tools: [tool("list_products")] },
    ]);
    expect(index.tools.map((t) => t.name)).toEqual([
      "store-a__list_products",
      "store-b__list_products",
    ]);
    expect(index.routes.get("store-a__list_products")).toEqual({
      slug: "store-a",
      upstreamName: "list_products",
      readOnly: false,
    });
    expect(index.routes.get("store-b__list_products")).toEqual({
      slug: "store-b",
      upstreamName: "list_products",
      readOnly: false,
    });
  });

  it("prefixes descriptions with the server name and keeps the schema", () => {
    const original = tool("get_order", "Get one order");
    original.inputSchema = { type: "object", properties: { id: { type: "number" } } };
    const [exposed] = buildToolIndex([
      { slug: "woocommerce", name: "WooCommerce", tools: [original] },
    ]).tools;
    expect(exposed.description).toBe("[WooCommerce] Get one order");
    expect(exposed.inputSchema).toEqual(original.inputSchema);
  });

  it("routes sanitised names back to the original upstream name", () => {
    const index = buildToolIndex([
      { slug: "docs", name: "Docs", tools: [tool("a.b"), tool("a_b")] },
    ]);
    const names = index.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(2);
    expect(names.map((n) => index.routes.get(n)!.upstreamName).sort()).toEqual(["a.b", "a_b"]);
  });
});

describe("buildToolIndex readOnly", () => {
  it("copies the upstream's readOnlyHint into the route", () => {
    const index = buildToolIndex([
      {
        slug: "shop",
        name: "Shop",
        tools: [
          { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
          { name: "unhinted", inputSchema: { type: "object" } },
        ],
      },
    ]);
    expect(index.routes.get("shop__read")?.readOnly).toBe(true);
    expect(index.routes.get("shop__write")?.readOnly).toBe(false);
    expect(index.routes.get("shop__unhinted")?.readOnly).toBe(false);
  });
});
