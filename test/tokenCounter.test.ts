import { describe, it, expect, beforeEach } from "vitest";
import { recordTokenUsage, getRunTokenTotals, resetTokenTotals } from "../src/lib/tokenCounter.js";

beforeEach(() => {
  resetTokenTotals();
});

describe("recordTokenUsage", () => {
  it("computes cost using Bedrock's per-million-token pricing", () => {
    // 1,000,000 input tokens at $3/M = $3.00; 1,000,000 output at $15/M = $15.00
    const record = recordTokenUsage("run-1", 1_000_000, 1_000_000);
    expect(record.estimated_cost_usd).toBeCloseTo(18.0, 5);
  });

  it("accumulates totals across multiple calls for the same run", () => {
    recordTokenUsage("run-2", 1000, 200);
    recordTokenUsage("run-2", 500, 100);
    const totals = getRunTokenTotals("run-2");
    expect(totals?.cumulative_input_tokens).toBe(1500);
    expect(totals?.cumulative_output_tokens).toBe(300);
    expect(totals?.cumulative_total_tokens).toBe(1800);
  });

  it("keeps totals for different runs separate", () => {
    recordTokenUsage("run-a", 100, 50);
    recordTokenUsage("run-b", 999, 999);
    expect(getRunTokenTotals("run-a")?.cumulative_total_tokens).toBe(150);
    expect(getRunTokenTotals("run-b")?.cumulative_total_tokens).toBe(1998);
  });

  it("flags over_budget once cumulative tokens exceed the configured ceiling", () => {
    // TOKEN_BUDGET_CEILING defaults to 100000 in config
    recordTokenUsage("run-big", 60000, 60000);
    const totals = getRunTokenTotals("run-big");
    expect(totals?.over_budget).toBe(true);
  });

  it("does not flag over_budget when under the ceiling", () => {
    recordTokenUsage("run-small", 100, 100);
    const totals = getRunTokenTotals("run-small");
    expect(totals?.over_budget).toBe(false);
  });
});
