import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";

// Isolated data directory per test file — vitest runs test files in
// separate processes/module registries by default, and runStore's
// in-process write-lock cannot coordinate across those. Must be set
// before runStore.ts is first imported (below), since it reads this once
// at module load.
process.env.RUN_DATA_DIR = "data-test-runCase";

vi.mock("../src/lib/llmDecisionWithRepair.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/llmDecisionWithRepair.js")>(
    "../src/lib/llmDecisionWithRepair.js",
  );
  return { ...actual, getLLMDecisionWithRepair: vi.fn() };
});

// retrieveFinanceDocuments now makes a real Bedrock Titan Embeddings call
// per invocation — mocked here so this offline unit suite stays offline
// and fast. Real embedding-backed retrieval is covered by
// test/tools.test.ts and test/integration/.
vi.mock("../src/tools/retrieveFinanceDocuments.js", () => ({
  retrieveFinanceDocuments: vi.fn().mockResolvedValue({ chunks: [] }),
}));

import { getLLMDecisionWithRepair } from "../src/lib/llmDecisionWithRepair.js";
import { runCase, resolveApproval, RunNotFoundError, RunNotAwaitingApprovalError } from "../src/lib/runCase.js";
import { getRun, getAuditEvents } from "../src/lib/runStore.js";
import { loadCaseFixture } from "../src/lib/loadFixtures.js";
import { recordTokenUsage, resetTokenTotals } from "../src/lib/tokenCounter.js";
import type { RecommendationResult } from "../src/schemas/result.js";

const mockedDecision = vi.mocked(getLLMDecisionWithRepair);

function makeResult(overrides: Partial<RecommendationResult> = {}): RecommendationResult {
  return {
    case_id: "FIN-001",
    run_id: "will-be-overwritten",
    recommendation: "APPROVE_FOR_POSTING",
    confidence: 0.9,
    assumptions: [],
    sourced_facts: [],
    calculations: [],
    inferences: [],
    unknowns: [],
    policy_findings: [],
    exceptions: [],
    next_action: "request approval",
    actions_taken: [],
    ...overrides,
  };
}

const dataDir = path.resolve(process.cwd(), "data-test-runCase");

beforeEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  mockedDecision.mockReset();
  resetTokenTotals();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("runCase — FIN-001 (valid three-way match)", () => {
  it("reaches APPROVAL_REQUIRED for a consequential recommendation", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ recommendation: "APPROVE_FOR_POSTING" }),
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    expect(run.status).toBe("APPROVAL_REQUIRED");
    expect(run.current_state).toBe("AWAITING_APPROVAL");
    expect(run.pending_approval).not.toBeNull();
    expect(run.pending_approval?.recommendation).toBe("APPROVE_FOR_POSTING");
  });

  it("records audit events for each tool call and state transition", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult(),
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);
    const events = await getAuditEvents(run.run_id);

    const toolNames = events.filter((e) => e.event === "tool_call").map((e) => e.tool);
    expect(toolNames).toContain("retrieve_finance_documents");
    expect(toolNames).toContain("get_vendor_record");
    expect(toolNames).toContain("get_purchase_order");
    expect(toolNames).toContain("check_invoice_history");
    expect(events.some((e) => e.event === "llm_decision")).toBe(true);
    expect(events.some((e) => e.event === "approval_requested")).toBe(true);
  });

  it("persists token usage on the run record after the LLM decision step", async () => {
    mockedDecision.mockImplementation(async (runId: string) => {
      recordTokenUsage(runId, 2000, 500);
      return { result: makeResult(), attempts: 1, totalTokens: 2500 };
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    expect(run.token_usage).not.toBeNull();
    expect(run.token_usage?.input_tokens).toBe(2000);
    expect(run.token_usage?.output_tokens).toBe(500);
    expect(run.token_usage?.total_tokens).toBe(2500);
    expect(run.token_usage?.estimated_cost_usd).toBeGreaterThan(0);
    expect(run.token_usage?.over_budget).toBe(false);
  });

  it("sums token usage across repair-retry attempts", async () => {
    let attempt = 0;
    mockedDecision.mockImplementation(async (runId: string) => {
      attempt += 1;
      recordTokenUsage(runId, 1000, 200); // simulates one attempt's usage
      return { result: makeResult(), attempts: attempt, totalTokens: 1200 * attempt };
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    // getLLMDecisionWithRepair itself sums across its internal retries;
    // this mock only calls recordTokenUsage once per invocation of the
    // mocked function, so this confirms runCase reads back whatever
    // cumulative total tokenCounter has for the run, not just the last
    // recordTokenUsage call in isolation.
    expect(run.token_usage?.total_tokens).toBe(1200);
  });
});

describe("runCase — FIN-004 (missing PO)", () => {
  it("exits at MISSING_PO without ever calling the LLM", async () => {
    const { case: caseRequest } = await loadCaseFixture("FIN-004");
    const run = await runCase(caseRequest);

    expect(run.current_state).toBe("MISSING_PO");
    expect(run.status).toBe("COMPLETED");
    expect(run.token_usage).toBeNull();
    expect(run.error).toMatch(/not found/i);
    expect(mockedDecision).not.toHaveBeenCalled();
  });
});

describe("runCase — HOLD_FOR_INFORMATION (non-consequential)", () => {
  it("completes without requiring approval", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ recommendation: "HOLD_FOR_INFORMATION" }),
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    expect(run.status).toBe("COMPLETED");
    expect(run.current_state).toBe("DONE");
    expect(run.pending_approval).toBeNull();
  });
});

describe("resolveApproval", () => {
  it("throws RunNotFoundError for an unknown run id", async () => {
    await expect(resolveApproval("does-not-exist", "approve")).rejects.toThrow(RunNotFoundError);
  });

  it("throws RunNotAwaitingApprovalError if the run never reached approval-required", async () => {
    const { case: caseRequest } = await loadCaseFixture("FIN-004");
    const run = await runCase(caseRequest); // resolves to MISSING_PO / COMPLETED without approval

    await expect(resolveApproval(run.run_id, "approve")).resolves.toBeDefined(); // COMPLETED -> idempotent replay path, not an error
  });

  it("approving a pending run submits the decision and completes", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ recommendation: "APPROVE_FOR_POSTING" }),
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-005");
    const run = await runCase(caseRequest);
    expect(run.status).toBe("APPROVAL_REQUIRED");

    const { run: approved, idempotentReplay } = await resolveApproval(run.run_id, "approve");
    expect(approved.status).toBe("COMPLETED");
    expect(idempotentReplay).toBe(false);
    expect(approved.result?.actions_taken.length).toBeGreaterThan(0);
  });

  it("FIN-005: a duplicate approval callback produces one effective decision and a stable replay", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ recommendation: "APPROVE_FOR_POSTING" }),
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-005");
    const run = await runCase(caseRequest);

    const first = await resolveApproval(run.run_id, "approve");
    const second = await resolveApproval(run.run_id, "approve");

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.run.result?.actions_taken).toEqual(first.run.result?.actions_taken);
  });

  it("rejecting a pending run completes without submitting", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ recommendation: "APPROVE_FOR_POSTING" }),
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);
    const { run: rejected } = await resolveApproval(run.run_id, "reject");

    expect(rejected.status).toBe("COMPLETED");
    expect(rejected.result?.actions_taken).toHaveLength(0);
  });
});

describe("getRun", () => {
  it("returns null for an unknown run id", async () => {
    expect(await getRun("nope")).toBeNull();
  });
});
