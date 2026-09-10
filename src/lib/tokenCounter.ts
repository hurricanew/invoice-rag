import { config } from "./config.js";

// Bedrock pricing, per million tokens (Claude Sonnet 4.5, us-east-1, as of
// project setup — see architecture.md cost notes). Verify against
// aws.amazon.com/bedrock/pricing before relying on this for real budgeting.
const INPUT_COST_PER_MILLION_USD = 3.0;
const OUTPUT_COST_PER_MILLION_USD = 15.0;

export interface TokenUsageRecord {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

export interface RunTokenTotals {
  run_id: string;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_total_tokens: number;
  cumulative_cost_usd: number;
  budget_ceiling: number;
  over_budget: boolean;
}

const runTotals = new Map<string, RunTokenTotals>();

export function recordTokenUsage(
  runId: string,
  inputTokens: number,
  outputTokens: number,
): TokenUsageRecord {
  const totalTokens = inputTokens + outputTokens;
  const cost =
    (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION_USD +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION_USD;

  const existing = runTotals.get(runId) ?? {
    run_id: runId,
    cumulative_input_tokens: 0,
    cumulative_output_tokens: 0,
    cumulative_total_tokens: 0,
    cumulative_cost_usd: 0,
    budget_ceiling: config.tokenBudgetCeiling,
    over_budget: false,
  };

  existing.cumulative_input_tokens += inputTokens;
  existing.cumulative_output_tokens += outputTokens;
  existing.cumulative_total_tokens += totalTokens;
  existing.cumulative_cost_usd += cost;
  existing.over_budget = existing.cumulative_total_tokens > existing.budget_ceiling;

  runTotals.set(runId, existing);

  return {
    run_id: runId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: cost,
  };
}

export function getRunTokenTotals(runId: string): RunTokenTotals | undefined {
  return runTotals.get(runId);
}

// Exposed for tests — this module holds in-process state across calls,
// which must not leak between unrelated test cases or CLI runs.
export function resetTokenTotals(runId?: string): void {
  if (runId) runTotals.delete(runId);
  else runTotals.clear();
}
