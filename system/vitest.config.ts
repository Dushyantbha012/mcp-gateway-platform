import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "system",
    include: ["*.system.test.ts"],
    // One long scripted scenario against the real cluster: steps share state
    // and run in order, and a real model is in the loop.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
