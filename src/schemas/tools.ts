import { z } from "zod";

// ---------------------------------------------------------------------------
// retrieve_finance_documents
// ---------------------------------------------------------------------------

export const RetrieveFinanceDocumentsInputSchema = z.object({
  query: z.string().min(1),
  top_k: z.number().int().positive().max(20).default(5),
});
export type RetrieveFinanceDocumentsInput = z.infer<typeof RetrieveFinanceDocumentsInputSchema>;

export const RetrievedChunkSchema = z.object({
  document_id: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["current", "superseded", "untrusted"]),
  page_or_section: z.string().optional(),
  relevance_score: z.number().min(0).max(1),
  text: z.string().min(1),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const RetrieveFinanceDocumentsOutputSchema = z.object({
  chunks: z.array(RetrievedChunkSchema),
});
export type RetrieveFinanceDocumentsOutput = z.infer<typeof RetrieveFinanceDocumentsOutputSchema>;

// ---------------------------------------------------------------------------
// get_vendor_record
// ---------------------------------------------------------------------------

export const GetVendorRecordInputSchema = z.object({
  vendor_id: z.string().min(1),
});
export type GetVendorRecordInput = z.infer<typeof GetVendorRecordInputSchema>;

export const GetVendorRecordOutputSchema = z.object({
  vendor_id: z.string().min(1),
  legal_name: z.string().min(1),
  status: z.enum(["ACTIVE", "BLOCKED", "DORMANT", "SANCTIONS_REVIEW", "PENDING_VERIFICATION"]),
  payment_details_masked: z.object({
    bank_account_last4: z.string().length(4),
    country: z.string().min(1),
  }),
  risk_flags: z.array(z.string()),
  bank_account_changed_at: z.string().datetime().nullable(),
  last_updated: z.string().datetime(),
});
export type GetVendorRecordOutput = z.infer<typeof GetVendorRecordOutputSchema>;

// ---------------------------------------------------------------------------
// get_purchase_order
// ---------------------------------------------------------------------------

export const PurchaseOrderLineSchema = z.object({
  line_number: z.number().int().positive(),
  description: z.string().min(1),
  quantity_ordered: z.number().positive(),
  quantity_received: z.number().nonnegative(),
  unit_price: z.number().nonnegative(),
  line_total: z.number().nonnegative(),
  line_type: z.enum(["goods", "services", "freight"]),
});
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLineSchema>;

export const GetPurchaseOrderInputSchema = z.object({
  po_number: z.string().min(1),
});
export type GetPurchaseOrderInput = z.infer<typeof GetPurchaseOrderInputSchema>;

export const GetPurchaseOrderOutputSchema = z.object({
  po_number: z.string().min(1),
  currency: z.string().length(3),
  approval_status: z.enum(["APPROVED", "PENDING", "REJECTED"]),
  lines: z.array(PurchaseOrderLineSchema),
  total: z.number().nonnegative(),
  goods_receipts: z.array(
    z.object({
      receipt_id: z.string().min(1),
      line_number: z.number().int().positive(),
      quantity_received: z.number().nonnegative(),
      received_at: z.string().datetime(),
    }),
  ),
  found: z.boolean(),
});
export type GetPurchaseOrderOutput = z.infer<typeof GetPurchaseOrderOutputSchema>;

// ---------------------------------------------------------------------------
// check_invoice_history
// ---------------------------------------------------------------------------

export const CheckInvoiceHistoryInputSchema = z.object({
  vendor_id: z.string().min(1),
  invoice_reference: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
});
export type CheckInvoiceHistoryInput = z.infer<typeof CheckInvoiceHistoryInputSchema>;

export const InvoiceHistoryMatchSchema = z.object({
  invoice_id: z.string().min(1),
  invoice_reference: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  status: z.enum(["paid", "posted", "held", "rejected"]),
  match_type: z.enum(["exact", "fuzzy"]),
  invoice_date: z.string().datetime().optional(),
});
export type InvoiceHistoryMatch = z.infer<typeof InvoiceHistoryMatchSchema>;

export const CheckInvoiceHistoryOutputSchema = z.object({
  matches: z.array(InvoiceHistoryMatchSchema),
});
export type CheckInvoiceHistoryOutput = z.infer<typeof CheckInvoiceHistoryOutputSchema>;

// ---------------------------------------------------------------------------
// submit_finance_decision
// ---------------------------------------------------------------------------

export const SubmitFinanceDecisionInputSchema = z.object({
  run_id: z.string().min(1),
  case_id: z.string().min(1),
  decision: z.enum([
    "APPROVE_FOR_POSTING",
    "HOLD_FOR_INFORMATION",
    "REJECT_DUPLICATE",
    "REJECT_INVALID",
    "ESCALATE_CONTROL_REVIEW",
  ]),
  amount: z.number().positive(),
  currency: z.string().length(3),
  idempotency_key: z.string().min(1),
  approval_reference: z.string().min(1),
});
export type SubmitFinanceDecisionInput = z.infer<typeof SubmitFinanceDecisionInputSchema>;

export const SubmitFinanceDecisionOutputSchema = z.object({
  posting_reference: z.string().min(1),
  status: z.enum(["POSTED", "HELD", "REJECTED"]),
  idempotent_replay: z.boolean(),
});
export type SubmitFinanceDecisionOutput = z.infer<typeof SubmitFinanceDecisionOutputSchema>;
