import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In the cluster the dashboard's Ingress sends /api to the gateway, so the
// browser sees one origin. `npm run dev` / `vite preview` do the same with a
// proxy; GATEWAY_URL picks which gateway (default: the k3d one).
const gateway = process.env.GATEWAY_URL ?? "http://gateway.local.test";
const proxy = { "/api": { target: gateway, changeOrigin: true } };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { proxy },
  preview: { proxy },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live in /e2e, not here.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
