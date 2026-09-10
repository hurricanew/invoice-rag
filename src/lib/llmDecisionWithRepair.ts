import { z } from "zod";
import { RecommendationResultSchema, type RecommendationResult } from "../schemas/result.js";
import { buildDecisionPrompt, type DecisionPromptInputs } from "./buildDecisionPrompt.js";
import { callBedrockDecision, GuardrailBlockedError } from "./bedrockDecision.js";
import { recordTokenUsage } from "./tokenCounter.js";

const MAX_REPAIR_ATTEMPTS = 2;

export class ModelOutputInvalidError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastErrors: string[],
  ) {
    super(
      `Model output failed schema validation after ${attempts} attempt(s): ${lastErrors.join("; ")}`,
    );
    this.name = "ModelOutputInvalidError";
  }
}

function extractJson(rawText: string): unknown {
  // Models occasionally wrap JSON in markdown fences despite instructions
  // not to — strip fences defensively before parsing, but do not attempt
  // any other repair of malformed JSON (that would be silently trusting
  // model output rather than treating a parse failure as invalid).
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : rawText;
  return JSON.parse(candidate);
}

export interface LLMDecisionOutcome {
  result: RecommendationResult;
  attempts: number;
  totalTokens: number;
}

export async function getLLMDecisionWithRepair(
  runId: string,
  promptInputs: Omit<DecisionPromptInputs, "validationErrors">,
): Promise<LLMDecisionOutcome> {
  let validationErrors: string[] | undefined;
  let totalTokens = 0;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt++) {
    const prompt = buildDecisionPrompt({ ...promptInputs, validationErrors });

    let callResult;
    try {
      callResult = await callBedrockDecision(prompt);
    } catch (err) {
      if (err instanceof GuardrailBlockedError) {
        // Guardrail intervention is itself a validation failure — treat it
        // as invalid output and let the repair loop react, rather than
        // crashing the run outright.
        validationErrors = [`Guardrail intervened: ${err.action}`];
        continue;
      }
      throw err;
    }

    const usage = recordTokenUsage(runId, callResult.inputTokens, callResult.outputTokens);
    totalTokens += usage.total_tokens;

    let parsedJson: unknown;
    try {
      parsedJson = extractJson(callResult.rawText);
    } catch {
      validationErrors = ["Response was not valid JSON."];
      continue;
    }

    const validation = RecommendationResultSchema.safeParse(parsedJson);
    if (validation.success) {
      return { result: validation.data, attempts: attempt, totalTokens };
    }

    validationErrors = validation.error.issues.map(
      (issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`,
    );
  }

  throw new ModelOutputInvalidError(MAX_REPAIR_ATTEMPTS + 1, validationErrors ?? ["unknown"]);
}
