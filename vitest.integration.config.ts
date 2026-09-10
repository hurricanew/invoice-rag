import { defineConfig } from "vitest/config";

// Model-dependent tests only — makes real Bedrock calls, real cost.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    reporters: ["verbose"],
  },
});
