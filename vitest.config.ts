import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The suite never touches the network. If something does, fail fast
    // instead of waiting on a real timeout.
    testTimeout: 10_000,
  },
});
