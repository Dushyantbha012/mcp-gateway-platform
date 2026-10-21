import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["woocommerce-mcp", "mcp-bridge", "gateway", "dashboard", "system"],
  },
});
