import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const config = {
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  bedrockModelId: requireEnv("BEDROCK_MODEL_ID"),
  bedrockGuardrailId: process.env.BEDROCK_GUARDRAIL_ID || undefined,
  bedrockGuardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION || undefined,
  tokenBudgetCeiling: Number(process.env.TOKEN_BUDGET_CEILING ?? "100000"),
};
