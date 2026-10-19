import html from "../index.html?raw";
import themeInit from "../public/theme-init.js?raw";
import { describe, expect, it } from "vitest";

// The dashboard is served with `script-src 'self'` (nginx security headers), so
// any inline <script> is blocked by the browser. This catches one sneaking back.
describe("index.html", () => {
  it("has no inline scripts", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body!.trim()).toBe("");
    }
  });

  it("ships the theme script as a file", () => {
    expect(themeInit).toContain("mcp-gateway-theme");
  });
});
