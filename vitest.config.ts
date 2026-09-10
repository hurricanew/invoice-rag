import { defineConfig } from "vitest/config";

// Default test run excludes test/integration — those tests make real
// Bedrock calls and incur real cost. Run them explicitly with
// `npm run test:integration`. This split satisfies the spec's requirement
// to separate stable unit/contract tests from model-dependent ones.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "test/integration/**"],
    reporters: ["verbose"],
  },
});
