import { z } from "zod";
import { RecommendationResultSchema } from "./result.js";

export const RunStatusSchema = z.enum([
  "IN_PROGRESS",
  "APPROVAL_REQUIRED",
  "COMPLETED",
  "FAILED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStateSchema = z.enum([
  "RETRIEVE_DOCUMENTS",
  "PARALLEL_LOOKUPS",
  "RECONCILE",
  "LLM_DECISION",
  "VALIDATE_OUTPUT",
  "AWAITING_APPROVAL",
  "SUBMIT_DECISION",
  "DONE",
  "MISSING_PO",
  "MISSING_RECEIPT",
  "MODEL_OUTPUT_INVALID",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const PendingApprovalSchema = z.object({
  run_id: z.string().min(1),
  case_id: z.string().min(1),
  recommendation: z.string().min(1),
  amount: z.number(),
  currency: z.string().length(3),
  vendor_id: z.string().min(1),
  exceptions_summary: z.array(z.string()),
  requested_at: z.string().datetime(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const TokenUsageSummarySchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  budget_ceiling: z.number().positive(),
  over_budget: z.boolean(),
});
export type TokenUsageSummary = z.infer<typeof TokenUsageSummarySchema>;

export const RunRecordSchema = z.object({
  run_id: z.string().min(1),
  case_id: z.string().min(1),
  status: RunStatusSchema,
  current_state: RunStateSchema,
  result: RecommendationResultSchema.nullable(),
  pending_approval: PendingApprovalSchema.nullable(),
  error: z.string().nullable(),
  // Null until the LLM decision step actually runs (e.g. a case that
  // exits at MISSING_PO before ever reaching Bedrock has no usage to
  // report). Present on every run that made at least one model call,
  // including repair-retry attempts summed together.
  token_usage: TokenUsageSummarySchema.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
