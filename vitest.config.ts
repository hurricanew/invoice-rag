import { defineConfig } from "vitest/config";

// Default test run excludes test/integration — those tests make real
// Bedrock calls and incur real cost. Run them explicitly with
// `npm run test:integration`. This split satisfies the spec's requirement
// to separate stable unit/contract tests from model-dependent ones.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "test/integration/**"],
    reporters: ["verbose"],
    // Several test files set process.env.RUN_DATA_DIR to isolate their
    // local JSON-file storage from each other (see runCase.test.ts).
    // Vitest's default parallel execution (multiple test files racing
    // concurrently, whether via threads or forks) does not reliably
    // isolate that env var or its filesystem side effects across files —
    // this showed up as intermittent cross-file test failures. Running
    // files fully sequentially, one at a time, is the only setting that
    // reliably fixed it. The suite is small enough that this costs
    // negligible wall-clock time.
    fileParallelism: false,
  },
});
