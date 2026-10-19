import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { isMetaTool, META_TOOLS, searchTools } from "./metaTools.js";
import { Bm25Ranker, tokenize } from "./rank.js";

const tool = (name: string, description: string, props: string[] = []): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
  },
});

const CATALOG: Tool[] = [
  tool("shop__list_orders", "[Shop] List recent orders, newest first", ["status", "page"]),
  tool("shop__get_order", "[Shop] Fetch one order by id", ["order_id"]),
  tool("shop__create_product", "[Shop] Create a new product in the catalog", ["name", "price"]),
  tool("shop__list_products", "[Shop] List products", ["category"]),
  tool("github__create_issue", "[GitHub] Open an issue in a repository", ["repo", "title", "body"]),
  tool("github__list_pull_requests", "[GitHub] List pull requests", ["repo", "state"]),
  tool("docs__searchPages", "[Docs] Full-text search across wiki pages", ["query"]),
];

const names = (query: string, tools = CATALOG) =>
  new Bm25Ranker().rank(query, tools).map((r) => r.tool.name);

describe("tokenize", () => {
  it("splits on punctuation, underscores, dashes and camelCase, and singularises", () => {
    expect(tokenize("shop__list_orders")).toEqual(["shop", "list", "order"]);
    expect(tokenize("searchPages-v2")).toEqual(["search", "page", "v2"]);
    expect(tokenize("Get the status of my orders")).toEqual(["get", "status", "order"]);
  });

  it("is empty for text with only stop words or symbols", () => {
    expect(tokenize("the of ... !!")).toEqual([]);
  });
});

describe("Bm25Ranker", () => {
  it("puts the tool named for the query first", () => {
    expect(names("list orders")[0]).toBe("shop__list_orders");
    expect(names("create issue")[0]).toBe("github__create_issue");
    expect(names("pull requests")[0]).toBe("github__list_pull_requests");
  });

  it("matches singular/plural and camelCase names", () => {
    expect(names("order")).toContain("shop__list_orders");
    expect(names("search pages")[0]).toBe("docs__searchPages");
  });

  it("finds a tool through its description or argument names", () => {
    expect(names("repository")[0]).toBe("github__create_issue");
    expect(names("price")[0]).toBe("shop__create_product");
  });

  it("matches the server name, since it is part of the exposed name", () => {
    expect(names("github").every((n) => n.startsWith("github__"))).toBe(true);
  });

  it("matches word prefixes, but ranks exact words above them", () => {
    const ranked = names("ord");
    expect(ranked).toContain("shop__get_order");
    const exactFirst = names("order")[0];
    expect(["shop__get_order", "shop__list_orders"]).toContain(exactFirst);
  });

  it("returns only tools that match, and nothing for an empty or unmatched query", () => {
    expect(names("zzzzqqq")).toEqual([]);
    expect(names("")).toEqual([]);
    expect(names("list orders")).not.toContain("docs__searchPages");
  });

  it("is deterministic: ties break by name", () => {
    const twins = [tool("a__same", "same words"), tool("b__same", "same words")];
    expect(names("same", twins)).toEqual(["a__same", "b__same"]);
    expect(names("same", [...twins].reverse())).toEqual(["a__same", "b__same"]);
  });

  it("copes with no tools", () => {
    expect(names("anything", [])).toEqual([]);
  });
});

describe("meta-tools", () => {
  it("are named so they can never collide with an exposed <server>__<tool> name", () => {
    expect(META_TOOLS.map((t) => t.name)).toEqual(["search_tools", "call_tool"]);
    expect(META_TOOLS.every((t) => !t.name.includes("__"))).toBe(true);
    expect(isMetaTool("call_tool")).toBe(true);
    expect(isMetaTool("shop__call_tool")).toBe(false);
  });
});

const run = (args: unknown, tools = CATALOG) => {
  const { result, count } = searchTools(tools, args, new Bm25Ranker());
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  return { result, count, body: result.isError ? text : JSON.parse(text) };
};

describe("searchTools", () => {
  it("returns exact names, server, description and the full input schema", () => {
    const { body, count, result } = run({ query: "create issue" });
    expect(result.isError).toBeUndefined();
    expect(count).toBeGreaterThan(0);
    expect(body.results[0]).toEqual({
      name: "github__create_issue",
      server: "github",
      description: "[GitHub] Open an issue in a repository",
      inputSchema: CATALOG[4].inputSchema,
    });
  });

  it("limits results and says how many matched", () => {
    const { body } = run({ query: "list", limit: 2 });
    expect(body.results).toHaveLength(2);
    expect(body.matched).toBeGreaterThan(2);
    expect(body.hint).toMatch(/Showing 2 of/);
  });

  it("narrows to one server", () => {
    const { body } = run({ query: "list", server: "github" });
    expect(body.results.map((r: { name: string }) => r.name)).toEqual([
      "github__list_pull_requests",
    ]);
  });

  it("lists servers, with counts and examples, for an empty query", () => {
    const { body, count } = run({});
    expect(count).toBe(0);
    expect(body.servers).toEqual([
      { server: "shop", toolCount: 4, examples: expect.any(Array) },
      { server: "github", toolCount: 2, examples: expect.any(Array) },
      { server: "docs", toolCount: 1, examples: ["docs__searchPages"] },
    ]);
  });

  it("only ever searches the tools it is given (so permissions hold)", () => {
    const visible = CATALOG.filter((t) => !t.name.startsWith("github__"));
    const { body } = run({ query: "issue repository github" }, visible);
    expect(JSON.stringify(body)).not.toContain("github__");
  });

  it("suggests what to do when nothing matches", () => {
    const { body } = run({ query: "zzzzqqq" });
    expect(body.results).toEqual([]);
    expect(body.hint).toMatch(/Nothing matched/);
  });

  it.each([[{ limit: 0 }], [{ limit: 99 }], [{ query: 5 }], [{ query: "x".repeat(501) }]])(
    "rejects invalid arguments %j with an error result",
    (args) => {
      const { result, body } = run(args);
      expect(result.isError).toBe(true);
      expect(body).toMatch(/Invalid arguments for search_tools/);
    },
  );
});
