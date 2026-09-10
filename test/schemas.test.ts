import { describe, it, expect } from "vitest";
import { CaseRequestSchema } from "../src/schemas/case.js";
import { AuditEventSchema } from "../src/schemas/audit.js";
import { RecommendationResultSchema } from "../src/schemas/result.js";
import {
  RetrieveFinanceDocumentsOutputSchema,
  GetVendorRecordOutputSchema,
  GetPurchaseOrderOutputSchema,
  CheckInvoiceHistoryOutputSchema,
  SubmitFinanceDecisionInputSchema,
} from "../src/schemas/tools.js";

describe("CaseRequestSchema", () => {
  it("accepts a valid case", () => {
    const result = CaseRequestSchema.safeParse({
      case_id: "FIN-001",
      invoice_reference: "INV-9001",
      vendor_id: "VEND-100",
      amount: 4820.0,
      currency: "AUD",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a case missing required fields", () => {
    const result = CaseRequestSchema.safeParse({
      case_id: "FIN-001",
      amount: 4820.0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    const result = CaseRequestSchema.safeParse({
      case_id: "FIN-001",
      invoice_reference: "INV-9001",
      vendor_id: "VEND-100",
      amount: -5,
      currency: "AUD",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a currency code that isn't 3 letters", () => {
    const result = CaseRequestSchema.safeParse({
      case_id: "FIN-001",
      invoice_reference: "INV-9001",
      vendor_id: "VEND-100",
      amount: 100,
      currency: "AUSTRALIA",
    });
    expect(result.success).toBe(false);
  });
});

describe("AuditEventSchema", () => {
  it("accepts a valid tool_call event", () => {
    const result = AuditEventSchema.safeParse({
      run_id: "run-1",
      event_id: "evt-1",
      ts: new Date().toISOString(),
      event: "tool_call",
      tool: "get_purchase_order",
      outcome: "success",
      duration_ms: 142,
      correlation_id: "corr-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown event type (allowlist enforcement)", () => {
    const result = AuditEventSchema.safeParse({
      run_id: "run-1",
      event_id: "evt-1",
      ts: new Date().toISOString(),
      event: "leaked_bank_details",
      outcome: "success",
      correlation_id: "corr-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    const result = AuditEventSchema.safeParse({
      run_id: "run-1",
      event_id: "evt-1",
      ts: "not-a-date",
      event: "tool_call",
      outcome: "success",
      correlation_id: "corr-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("RecommendationResultSchema", () => {
  const validResult = {
    case_id: "FIN-001",
    run_id: "run-1",
    recommendation: "APPROVE_FOR_POSTING",
    confidence: 0.94,
    assumptions: [],
    sourced_facts: [
      {
        statement: "Invoice total matches PO-88213 line total",
        source: { document_id: "PO-88213", version: "2" },
      },
    ],
    calculations: [
      {
        label: "variance",
        formula: "invoice_total - po_total",
        inputs: { invoice_total: 4820, po_total: 4820 },
        result: 0,
      },
    ],
    inferences: [],
    unknowns: [],
    policy_findings: [
      {
        rule: "approver limit",
        source: { document_id: "FIN-POL-003", version: "4.0" },
        compliant: true,
        detail: "AUD 10,000 limit covers this amount",
      },
    ],
    exceptions: [],
    next_action: "request approval",
    actions_taken: [],
  };

  it("accepts a fully valid result", () => {
    const result = RecommendationResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
  });

  it("rejects a result missing confidence", () => {
    const { confidence, ...withoutConfidence } = validResult;
    const result = RecommendationResultSchema.safeParse(withoutConfidence);
    expect(result.success).toBe(false);
  });

  it("rejects a result missing assumptions", () => {
    const { assumptions, ...withoutAssumptions } = validResult;
    const result = RecommendationResultSchema.safeParse(withoutAssumptions);
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0-1", () => {
    const result = RecommendationResultSchema.safeParse({ ...validResult, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized recommendation value", () => {
    const result = RecommendationResultSchema.safeParse({
      ...validResult,
      recommendation: "PAY_IMMEDIATELY",
    });
    expect(result.success).toBe(false);
  });
});

describe("tool contract schemas", () => {
  it("RetrieveFinanceDocumentsOutputSchema accepts ranked chunks with citation metadata", () => {
    const result = RetrieveFinanceDocumentsOutputSchema.safeParse({
      chunks: [
        {
          document_id: "FIN-POL-002",
          title: "Three-Way Matching and Tolerances",
          version: "2.4",
          status: "current",
          relevance_score: 0.91,
          text: "Tolerances are calculated per line...",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("RetrieveFinanceDocumentsOutputSchema rejects an invalid status enum", () => {
    const result = RetrieveFinanceDocumentsOutputSchema.safeParse({
      chunks: [
        {
          document_id: "FIN-POL-002",
          title: "x",
          version: "1",
          status: "verified", // not a valid enum value
          relevance_score: 0.5,
          text: "x",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("GetVendorRecordOutputSchema masks bank details to last 4 digits by shape", () => {
    const result = GetVendorRecordOutputSchema.safeParse({
      vendor_id: "VEND-100",
      legal_name: "Acme Pty Ltd",
      status: "ACTIVE",
      payment_details_masked: { bank_account_last4: "8842", country: "AU" },
      risk_flags: [],
      bank_account_changed_at: null,
      last_updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("GetVendorRecordOutputSchema rejects a full bank account number in the masked field", () => {
    const result = GetVendorRecordOutputSchema.safeParse({
      vendor_id: "VEND-100",
      legal_name: "Acme Pty Ltd",
      status: "ACTIVE",
      payment_details_masked: { bank_account_last4: "123456789", country: "AU" },
      risk_flags: [],
      bank_account_changed_at: null,
      last_updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("GetPurchaseOrderOutputSchema accepts a found PO with lines and receipts", () => {
    const result = GetPurchaseOrderOutputSchema.safeParse({
      po_number: "PO-88213",
      currency: "AUD",
      approval_status: "APPROVED",
      lines: [
        {
          line_number: 1,
          description: "Widgets",
          quantity_ordered: 100,
          quantity_received: 100,
          unit_price: 48.2,
          line_total: 4820,
          line_type: "goods",
        },
      ],
      total: 4820,
      goods_receipts: [
        {
          receipt_id: "GR-55021",
          line_number: 1,
          quantity_received: 100,
          received_at: new Date().toISOString(),
        },
      ],
      found: true,
    });
    expect(result.success).toBe(true);
  });

  it("CheckInvoiceHistoryOutputSchema accepts an exact-match duplicate", () => {
    const result = CheckInvoiceHistoryOutputSchema.safeParse({
      matches: [
        {
          invoice_id: "INV-8001",
          invoice_reference: "INV-9001",
          amount: 4820,
          currency: "AUD",
          status: "paid",
          match_type: "exact",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("SubmitFinanceDecisionInputSchema requires an idempotency key and approval reference", () => {
    const withoutIdempotencyKey = SubmitFinanceDecisionInputSchema.safeParse({
      run_id: "run-1",
      case_id: "FIN-001",
      decision: "APPROVE_FOR_POSTING",
      amount: 4820,
      currency: "AUD",
      approval_reference: "appr-1",
    });
    expect(withoutIdempotencyKey.success).toBe(false);

    const valid = SubmitFinanceDecisionInputSchema.safeParse({
      run_id: "run-1",
      case_id: "FIN-001",
      decision: "APPROVE_FOR_POSTING",
      amount: 4820,
      currency: "AUD",
      idempotency_key: "run-1",
      approval_reference: "appr-1",
    });
    expect(valid.success).toBe(true);
  });
});
