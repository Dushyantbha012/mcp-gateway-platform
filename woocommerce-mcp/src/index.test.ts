import { describe, expect, it } from "vitest";
import { placeholder } from "./index.js";

describe("scaffold smoke test", () => {
  it("resolves TS + Vitest wiring for this package", () => {
    expect(placeholder()).toBe("woocommerce-mcp scaffold");
  });
});
