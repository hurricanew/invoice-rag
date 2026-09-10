import { z } from "zod";

const CitationSchema = z.object({
  document_id: z.string().min(1),
  version: z.string().min(1),
  page_or_section: z.string().optional(),
});

export const SourcedFactSchema = z.object({
  statement: z.string().min(1),
  source: CitationSchema,
});

export const CalculationSchema = z.object({
  label: z.string().min(1),
  formula: z.string().min(1),
  inputs: z.record(z.string(), z.number()),
  result: z.number(),
  rounding_method: z.string().optional(),
});

export const InferenceSchema = z.object({
  statement: z.string().min(1),
  based_on: z.array(z.string()).min(1),
});

export const PolicyFindingSchema = z.object({
  rule: z.string().min(1),
  source: CitationSchema,
  compliant: z.boolean(),
  detail: z.string().min(1),
});

export const ExceptionSchema = z.object({
  category: z.enum([
    "MISSING_PO",
    "MISSING_RECEIPT",
    "PRICE_VARIANCE",
    "QUANTITY_VARIANCE",
    "DUPLICATE_RISK",
    "VENDOR_BLOCK",
    "BANK_CHANGE",
    "AUTHORITY_GAP",
    "TAX_QUERY",
    "OTHER_CONTROL_RISK",
  ]),
  expected: z.string().min(1),
  observed: z.string().min(1),
  source: CitationSchema.optional(),
  owner: z.string().min(1),
});

export const ActionTakenSchema = z.object({
  action: z.string().min(1),
  ts: z.string().datetime(),
  reference: z.string().optional(),
});

export const RecommendationResultSchema = z.object({
  case_id: z.string().min(1),
  run_id: z.string().min(1),
  recommendation: z.enum([
    "APPROVE_FOR_POSTING",
    "HOLD_FOR_INFORMATION",
    "REJECT_DUPLICATE",
    "REJECT_INVALID",
    "ESCALATE_CONTROL_REVIEW",
  ]),
  confidence: z.number().min(0).max(1),
  assumptions: z.array(z.string()),
  sourced_facts: z.array(SourcedFactSchema),
  calculations: z.array(CalculationSchema),
  inferences: z.array(InferenceSchema),
  unknowns: z.array(z.string()),
  policy_findings: z.array(PolicyFindingSchema),
  exceptions: z.array(ExceptionSchema),
  next_action: z.string().min(1),
  actions_taken: z.array(ActionTakenSchema),
});
export type RecommendationResult = z.infer<typeof RecommendationResultSchema>;
