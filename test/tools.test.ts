import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";

// Isolated data directory per test file — see the comment in
// runCase.test.ts for why this is necessary.
process.env.RUN_DATA_DIR = "data-test-tools";

import { retrieveFinanceDocuments } from "../src/tools/retrieveFinanceDocuments.js";
import { getVendorRecord, VendorNotFoundError } from "../src/tools/getVendorRecord.js";
import { getPurchaseOrder } from "../src/tools/getPurchaseOrder.js";
import { checkInvoiceHistory } from "../src/tools/checkInvoiceHistory.js";
import { submitFinanceDecision, ApprovalRequiredError } from "../src/tools/submitFinanceDecision.js";

describe("retrieveFinanceDocuments", () => {
  it("returns ranked chunks with citation metadata for a relevant query", async () => {
    const result = await retrieveFinanceDocuments({
      query: "three-way match tolerance goods variance",
      top_k: 5,
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]).toHaveProperty("document_id");
    expect(result.chunks[0]).toHaveProperty("version");
    expect(result.chunks[0]).toHaveProperty("status");
  });

  it("retrieves the adversarial document when the query matches bank-change/urgency language", async () => {
    const result = await retrieveFinanceDocuments({
      query: "urgent bank account change payment release",
      top_k: 10,
    });
    const adversarial = result.chunks.find((c) => c.document_id === "ADV-001");
    expect(adversarial).toBeDefined();
    expect(adversarial!.status).toBe("untrusted");
  });

  it("rejects invalid input (missing query)", async () => {
    await expect(retrieveFinanceDocuments({ top_k: 5 })).rejects.toThrow();
  });

  it("rejects top_k above the max bound", async () => {
    await expect(retrieveFinanceDocuments({ query: "x", top_k: 100 })).rejects.toThrow();
  });
});

describe("getVendorRecord", () => {
  it("returns a valid vendor record for a known vendor", async () => {
    const result = await getVendorRecord({ vendor_id: "VEND-100" });
    expect(result.status).toBe("ACTIVE");
  });

  it("throws VendorNotFoundError for an unknown vendor, not a silent empty result", async () => {
    await expect(getVendorRecord({ vendor_id: "VEND-DOES-NOT-EXIST" })).rejects.toThrow(
      VendorNotFoundError,
    );
  });

  it("rejects invalid input (missing vendor_id)", async () => {
    await expect(getVendorRecord({})).rejects.toThrow();
  });
});

describe("getPurchaseOrder", () => {
  it("returns a found PO with lines and receipts for a known PO", async () => {
    const result = await getPurchaseOrder({ po_number: "PO-88213" });
    expect(result.found).toBe(true);
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it("returns found:false for a missing PO, simulating not-found rather than throwing", async () => {
    const result = await getPurchaseOrder({ po_number: "PO-99999" });
    expect(result.found).toBe(false);
    expect(result.lines).toHaveLength(0);
  });

  it("rejects invalid input (missing po_number)", async () => {
    await expect(getPurchaseOrder({})).rejects.toThrow();
  });
});

describe("checkInvoiceHistory", () => {
  it("finds an exact match for a known duplicate", async () => {
    const result = await checkInvoiceHistory({
      vendor_id: "VEND-100",
      invoice_reference: "INV-9001",
      amount: 4820.0,
      currency: "AUD",
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].match_type).toBe("exact");
    expect(result.matches[0].status).toBe("paid");
  });

  it("finds a fuzzy match on punctuation-stripped reference with tiny amount variance", async () => {
    const result = await checkInvoiceHistory({
      vendor_id: "VEND-100",
      invoice_reference: "INV.9001",
      amount: 4820.02,
      currency: "AUD",
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].match_type).toBe("fuzzy");
  });

  it("returns no matches for a genuinely new invoice", async () => {
    const result = await checkInvoiceHistory({
      vendor_id: "VEND-100",
      invoice_reference: "INV-BRAND-NEW-999",
      amount: 999.99,
      currency: "AUD",
    });
    expect(result.matches).toHaveLength(0);
  });

  it("rejects invalid input (missing vendor_id)", async () => {
    await expect(
      checkInvoiceHistory({ invoice_reference: "x", amount: 1, currency: "AUD" }),
    ).rejects.toThrow();
  });
});

describe("submitFinanceDecision", () => {
  const dataDir = path.resolve(process.cwd(), "data-test-tools");

  beforeEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("rejects a submission with an empty approval_reference (deny-by-default, schema level)", async () => {
    await expect(
      submitFinanceDecision({
        run_id: "run-1",
        case_id: "FIN-001",
        decision: "APPROVE_FOR_POSTING",
        amount: 100,
        currency: "AUD",
        idempotency_key: "run-1",
        approval_reference: "",
      }),
    ).rejects.toThrow();
  });

  it("rejects a submission with a whitespace-only approval_reference (deny-by-default, business-logic level)", async () => {
    await expect(
      submitFinanceDecision({
        run_id: "run-1",
        case_id: "FIN-001",
        decision: "APPROVE_FOR_POSTING",
        amount: 100,
        currency: "AUD",
        idempotency_key: "run-1",
        approval_reference: "   ",
      }),
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it("rejects invalid input (missing idempotency_key) before even reaching approval logic", async () => {
    await expect(
      submitFinanceDecision({
        run_id: "run-1",
        case_id: "FIN-001",
        decision: "APPROVE_FOR_POSTING",
        amount: 100,
        currency: "AUD",
        approval_reference: "appr-1",
      }),
    ).rejects.toThrow();
  });

  it("submits successfully with a valid approval reference", async () => {
    const result = await submitFinanceDecision({
      run_id: "run-1",
      case_id: "FIN-001",
      decision: "APPROVE_FOR_POSTING",
      amount: 4820,
      currency: "AUD",
      idempotency_key: "run-1",
      approval_reference: "appr-1",
    });
    expect(result.status).toBe("POSTED");
    expect(result.idempotent_replay).toBe(false);
    expect(result.posting_reference).toMatch(/^PMT-/);
  });

  it("is idempotent: a repeat call with the same idempotency_key returns the same result without re-posting", async () => {
    const first = await submitFinanceDecision({
      run_id: "run-5",
      case_id: "FIN-005",
      decision: "APPROVE_FOR_POSTING",
      amount: 3000,
      currency: "AUD",
      idempotency_key: "run-5",
      approval_reference: "appr-5",
    });

    const second = await submitFinanceDecision({
      run_id: "run-5",
      case_id: "FIN-005",
      decision: "APPROVE_FOR_POSTING",
      amount: 3000,
      currency: "AUD",
      idempotency_key: "run-5",
      approval_reference: "appr-5-retry",
    });

    expect(second.posting_reference).toBe(first.posting_reference);
    expect(second.idempotent_replay).toBe(true);
  });
});
