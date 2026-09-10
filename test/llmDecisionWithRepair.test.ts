import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/bedrockDecision.js", () => ({
  callBedrockDecision: vi.fn(),
  GuardrailBlockedError: class GuardrailBlockedError extends Error {
    constructor(public readonly action: string) {
      super(`blocked: ${action}`);
    }
  },
}));

import { callBedrockDecision, GuardrailBlockedError } from "../src/lib/bedrockDecision.js";
import { getLLMDecisionWithRepair, ModelOutputInvalidError } from "../src/lib/llmDecisionWithRepair.js";
import { resetTokenTotals, getRunTokenTotals } from "../src/lib/tokenCounter.js";
import type { CaseRequest } from "../src/schemas/case.js";

const mockedCall = vi.mocked(callBedrockDecision);

const baseCase: CaseRequest = {
  case_id: "FIN-TEST",
  invoice_reference: "INV-1",
  vendor_id: "VEND-100",
  amount: 100,
  currency: "AUD",
};

const validResultJson = {
  case_id: "FIN-TEST",
  run_id: "run-x",
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
};

const promptInputs = {
  caseRequest: baseCase,
  retrievedChunks: [],
  matchResult: null,
  duplicateResult: { outcome: "NONE" as const, exceptions: [] },
  authorityResult: null,
  poFound: false,
  hasReceipt: false,
};

beforeEach(() => {
  mockedCall.mockReset();
  resetTokenTotals();
});

describe("getLLMDecisionWithRepair", () => {
  it("returns the parsed result on a valid first response, attempts = 1", async () => {
    mockedCall.mockResolvedValueOnce({
      rawText: JSON.stringify(validResultJson),
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      guardrailIntervened: false,
    });

    const outcome = await getLLMDecisionWithRepair("run-a", promptInputs);
    expect(outcome.attempts).toBe(1);
    expect(outcome.result.recommendation).toBe("APPROVE_FOR_POSTING");
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });

  it("strips markdown fences before parsing JSON", async () => {
    mockedCall.mockResolvedValueOnce({
      rawText: "```json\n" + JSON.stringify(validResultJson) + "\n```",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      guardrailIntervened: false,
    });

    const outcome = await getLLMDecisionWithRepair("run-b", promptInputs);
    expect(outcome.result.recommendation).toBe("APPROVE_FOR_POSTING");
  });

  it("retries with the validation error appended when the first response is invalid JSON", async () => {
    mockedCall
      .mockResolvedValueOnce({
        rawText: "not json at all",
        inputTokens: 400,
        outputTokens: 50,
        totalTokens: 450,
        guardrailIntervened: false,
      })
      .mockResolvedValueOnce({
        rawText: JSON.stringify(validResultJson),
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        guardrailIntervened: false,
      });

    const outcome = await getLLMDecisionWithRepair("run-c", promptInputs);
    expect(outcome.attempts).toBe(2);
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });

  it("retries when the response is schema-invalid (missing required field)", async () => {
    const { confidence, ...invalid } = validResultJson;
    mockedCall
      .mockResolvedValueOnce({
        rawText: JSON.stringify(invalid),
        inputTokens: 400,
        outputTokens: 50,
        totalTokens: 450,
        guardrailIntervened: false,
      })
      .mockResolvedValueOnce({
        rawText: JSON.stringify(validResultJson),
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        guardrailIntervened: false,
      });

    const outcome = await getLLMDecisionWithRepair("run-d", promptInputs);
    expect(outcome.attempts).toBe(2);
  });

  it("throws ModelOutputInvalidError after exhausting all repair attempts (max 2 retries = 3 total calls)", async () => {
    mockedCall.mockResolvedValue({
      rawText: "still not json",
      inputTokens: 400,
      outputTokens: 50,
      totalTokens: 450,
      guardrailIntervened: false,
    });

    await expect(getLLMDecisionWithRepair("run-e", promptInputs)).rejects.toThrow(
      ModelOutputInvalidError,
    );
    expect(mockedCall).toHaveBeenCalledTimes(3);
  });

  it("treats a guardrail intervention as a repairable validation failure, not an immediate crash", async () => {
    mockedCall
      .mockRejectedValueOnce(new GuardrailBlockedError("denied_topic"))
      .mockResolvedValueOnce({
        rawText: JSON.stringify(validResultJson),
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        guardrailIntervened: false,
      });

    const outcome = await getLLMDecisionWithRepair("run-f", promptInputs);
    expect(outcome.attempts).toBe(2);
  });

  it("accumulates token usage across repair attempts in the token counter", async () => {
    mockedCall
      .mockResolvedValueOnce({
        rawText: "bad json",
        inputTokens: 400,
        outputTokens: 50,
        totalTokens: 450,
        guardrailIntervened: false,
      })
      .mockResolvedValueOnce({
        rawText: JSON.stringify(validResultJson),
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        guardrailIntervened: false,
      });

    await getLLMDecisionWithRepair("run-g", promptInputs);
    const totals = getRunTokenTotals("run-g");
    expect(totals?.cumulative_total_tokens).toBe(450 + 600);
  });
});
