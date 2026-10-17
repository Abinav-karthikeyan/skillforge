import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests that drive real git repositories (code intelligence, observer) can pass
    // the 5 s default on a busy Windows machine or CI runner.
    testTimeout: 20_000,
  },
});
