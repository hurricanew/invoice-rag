import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";

// Isolated data directory per test file — see the comment in
// runCase.test.ts for why this is necessary.
process.env.RUN_DATA_DIR = "data-test-evaluations";

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
import { runEvaluation, runAllEvaluations } from "../src/lib/evaluations.js";
import type { RecommendationResult } from "../src/schemas/result.js";

const mockedDecision = vi.mocked(getLLMDecisionWithRepair);

function makeResult(overrides: Partial<RecommendationResult> = {}): RecommendationResult {
  return {
    case_id: "FIN-001",
    run_id: "x",
    recommendation: "APPROVE_FOR_POSTING",
    confidence: 0.9,
    assumptions: [],
    sourced_facts: [{ statement: "matches", source: { document_id: "FIN-POL-002", version: "2.4" } }],
    calculations: [{ label: "variance", formula: "abs(a-b)", inputs: { a: 1, b: 1 }, result: 0 }],
    inferences: [],
    unknowns: [],
    policy_findings: [],
    exceptions: [],
    next_action: "request approval",
    actions_taken: [],
    ...overrides,
  };
}

// Mocks a correctly-behaving model for each FIN-00X case, so these tests
// verify the EVALUATION LOGIC (does it correctly grade a good run as a
// pass), not model behavior itself — that's covered separately by the
// live integration suite and by runCase.test.ts's mocked orchestration
// tests.
const GOOD_RESULTS: Record<string, RecommendationResult> = {
  "FIN-001": makeResult({ case_id: "FIN-001", recommendation: "APPROVE_FOR_POSTING" }),
  "FIN-002": makeResult({ case_id: "FIN-002", recommendation: "REJECT_DUPLICATE" }),
  "FIN-003": makeResult({
    case_id: "FIN-003",
    recommendation: "ESCALATE_CONTROL_REVIEW",
    exceptions: [
      {
        category: "OTHER_CONTROL_RISK",
        expected: "compliance",
        observed: "bypass attempt",
        owner: "Financial Control",
      },
    ],
    next_action: "Escalate to Financial Control for review.",
  }),
  "FIN-005": makeResult({ case_id: "FIN-005", recommendation: "APPROVE_FOR_POSTING" }),
};

const dataDir = path.resolve(process.cwd(), "data-test-evaluations");

beforeEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  mockedDecision.mockReset();
  mockedDecision.mockImplementation(async (_runId, promptInputs) => {
    const caseId = promptInputs.caseRequest.case_id;
    const result = GOOD_RESULTS[caseId];
    if (!result) {
      throw new Error(`Test setup error: no mocked result defined for case ${caseId}`);
    }
    return { result, attempts: 1, totalTokens: 100 };
  });
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("runEvaluation", () => {
  it("FIN-001: a correct APPROVE_FOR_POSTING run passes all checks", async () => {
    const result = await runEvaluation("FIN-001");
    expect(result.overall_pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it("FIN-001: an incorrect recommendation fails the evaluation", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ case_id: "FIN-001", recommendation: "REJECT_INVALID" }),
      attempts: 1,
      totalTokens: 100,
    });
    const result = await runEvaluation("FIN-001");
    expect(result.overall_pass).toBe(false);
  });

  it("FIN-002: a correct REJECT_DUPLICATE run passes", async () => {
    const result = await runEvaluation("FIN-002");
    expect(result.overall_pass).toBe(true);
  });

  it("FIN-002: an APPROVE_FOR_POSTING recommendation fails the evaluation", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ case_id: "FIN-002", recommendation: "APPROVE_FOR_POSTING" }),
      attempts: 1,
      totalTokens: 100,
    });
    const result = await runEvaluation("FIN-002");
    expect(result.overall_pass).toBe(false);
    expect(result.checks.find((c) => c.description.includes("never proposes payment"))?.pass).toBe(false);
  });

  it("FIN-003: correctly flagging the injection attempt passes", async () => {
    const result = await runEvaluation("FIN-003");
    expect(result.overall_pass).toBe(true);
  });

  it("FIN-003: complying with the injection (APPROVE_FOR_POSTING) fails the evaluation", async () => {
    mockedDecision.mockResolvedValue({
      result: makeResult({ case_id: "FIN-003", recommendation: "APPROVE_FOR_POSTING" }),
      attempts: 1,
      totalTokens: 100,
    });
    const result = await runEvaluation("FIN-003");
    expect(result.overall_pass).toBe(false);
  });

  it("FIN-004: passes without ever calling the mocked LLM (exits at MISSING_PO first)", async () => {
    const result = await runEvaluation("FIN-004");
    expect(result.overall_pass).toBe(true);
    expect(mockedDecision).not.toHaveBeenCalled();
  });

  it("FIN-005: a clean approval followed by a duplicate callback passes", async () => {
    const result = await runEvaluation("FIN-005");
    expect(result.overall_pass).toBe(true);
  });
});

describe("runAllEvaluations", () => {
  it("runs all 5 cases and all pass when the model behaves correctly", async () => {
    const results = await runAllEvaluations();
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.overall_pass)).toBe(true);
  });
});
