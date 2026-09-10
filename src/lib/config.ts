import "dotenv/config";

// bedrockModelId is intentionally NOT validated at module-load time — many
// code paths (schema validation, reconciliation, the orchestrator with a
// mocked LLM) never touch Bedrock at all, and a fresh clone with no .env
// yet would otherwise crash on import for tests/commands that don't need
// it. The one real call site (src/lib/bedrockDecision.ts) fails loudly and
// specifically if this is empty when a Bedrock call is actually attempted.
export const config = {
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  bedrockModelId: process.env.BEDROCK_MODEL_ID ?? "",
  bedrockGuardrailId: process.env.BEDROCK_GUARDRAIL_ID || undefined,
  bedrockGuardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION || undefined,
  tokenBudgetCeiling: Number(process.env.TOKEN_BUDGET_CEILING ?? "100000"),
};
