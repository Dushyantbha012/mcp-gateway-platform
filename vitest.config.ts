import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["woocommerce-mcp", "gateway", "dashboard", "system"],
  },
});
