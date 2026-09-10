import { describe, it, expect } from "vitest";
import {
  loadCaseFixture,
  loadVendorFixture,
  loadPurchaseOrderFixture,
  loadInvoiceHistory,
  ALL_CASE_IDS,
} from "../src/lib/loadFixtures.js";

describe("case fixtures", () => {
  it.each(ALL_CASE_IDS)("%s parses against CaseRequestSchema", async (caseId) => {
    const { case: parsed } = await loadCaseFixture(caseId);
    expect(parsed.case_id).toBe(caseId);
  });

  it("FIN-003 carries the adversarial attachment as untrusted case data", async () => {
    const { case: parsed } = await loadCaseFixture("FIN-003");
    expect(parsed.attachments).toBeDefined();
    expect(parsed.attachments![0].content).toMatch(/ignore all previous policies/i);
  });
});

describe("vendor fixtures", () => {
  it("VEND-100 is ACTIVE with no recent bank change", async () => {
    const vendor = await loadVendorFixture("VEND-100");
    expect(vendor.status).toBe("ACTIVE");
    expect(vendor.bank_account_changed_at).toBeNull();
  });

  it("VEND-200's real bank details do not match the adversarial claim in FIN-003", async () => {
    const vendor = await loadVendorFixture("VEND-200");
    expect(vendor.payment_details_masked.bank_account_last4).not.toBe("8842");
    expect(vendor.bank_account_changed_at).toBeNull();
  });
});

describe("purchase order fixtures", () => {
  it("PO-88213 (FIN-001/FIN-002) is fully received and matches the invoice total", async () => {
    const po = await loadPurchaseOrderFixture("PO-88213");
    expect(po).not.toBeNull();
    expect(po!.total).toBe(4820.0);
    expect(po!.goods_receipts[0].quantity_received).toBe(po!.lines[0].quantity_ordered);
  });

  it("PO-99999 (FIN-004) does not exist, simulating a missing/timed-out lookup", async () => {
    const po = await loadPurchaseOrderFixture("PO-99999");
    expect(po).toBeNull();
  });
});

describe("invoice history fixture", () => {
  it("contains a paid record that exactly matches FIN-002's invoice", async () => {
    const history = await loadInvoiceHistory();
    const match = history.find(
      (h) =>
        h.vendor_id === "VEND-100" && h.invoice_reference === "INV-9001" && h.amount === 4820.0,
    );
    expect(match).toBeDefined();
    expect(match!.status).toBe("paid");
  });
});
