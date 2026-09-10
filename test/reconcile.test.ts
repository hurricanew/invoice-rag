import { describe, it, expect } from "vitest";
import { checkLineTolerance, reconcileThreeWayMatch } from "../src/lib/reconcileThreeWayMatch.js";
import { reconcileDuplicates } from "../src/lib/reconcileDuplicates.js";
import { reconcileAuthority } from "../src/lib/reconcileAuthority.js";
import type { PurchaseOrderLine, GetPurchaseOrderOutput } from "../src/schemas/tools.js";

describe("checkLineTolerance — goods", () => {
  const goodsLine: PurchaseOrderLine = {
    line_number: 1,
    description: "Widgets",
    quantity_ordered: 100,
    quantity_received: 100,
    unit_price: 48.2,
    line_total: 4820.0,
    line_type: "goods",
  };

  it("threshold is the lower of AUD 50 or 1% of line value (1% of 4820 = 48.20, lower than 50)", () => {
    const result = checkLineTolerance(goodsLine, 4820.0);
    expect(result.threshold_applied).toBeCloseTo(48.2, 5);
  });

  it("exact match (variance 0) is within tolerance", () => {
    const result = checkLineTolerance(goodsLine, 4820.0);
    expect(result.variance).toBe(0);
    expect(result.within_tolerance).toBe(true);
  });

  it("a variance just under the 1% threshold is within tolerance", () => {
    // threshold is 48.20; invoice 4860 => variance 40.00, under threshold
    const result = checkLineTolerance(goodsLine, 4860.0);
    expect(result.variance).toBeCloseTo(40.0, 5);
    expect(result.within_tolerance).toBe(true);
  });

  it("a variance over the 1% threshold is NOT within tolerance", () => {
    // invoice 4900 => variance 80.00, over the 48.20 threshold
    const result = checkLineTolerance(goodsLine, 4900.0);
    expect(result.variance).toBeCloseTo(80.0, 5);
    expect(result.within_tolerance).toBe(false);
  });

  it("for a high-value goods line, AUD 50 fixed cap applies instead of the 1% (lower of the two)", () => {
    // line_total 10000 => 1% = 100, fixed cap 50 is lower, so threshold = 50
    const highValueLine: PurchaseOrderLine = { ...goodsLine, line_total: 10000, unit_price: 100 };
    const result = checkLineTolerance(highValueLine, 10000);
    expect(result.threshold_applied).toBe(50);
  });

  it("invoiced quantity exceeding received quantity fails tolerance regardless of price variance", () => {
    const underReceived: PurchaseOrderLine = { ...goodsLine, quantity_received: 90 };
    const result = checkLineTolerance(underReceived, 4820.0); // price matches exactly
    expect(result.within_tolerance).toBe(false);
  });
});

describe("checkLineTolerance — services and freight", () => {
  it("services: threshold is the lower of AUD 100 or 2% of line value", () => {
    const servicesLine: PurchaseOrderLine = {
      line_number: 1,
      description: "Consulting",
      quantity_ordered: 1,
      quantity_received: 1,
      unit_price: 6200,
      line_total: 6200,
      line_type: "services",
    };
    // 2% of 6200 = 124, fixed cap 100 is lower
    const result = checkLineTolerance(servicesLine, 6200);
    expect(result.threshold_applied).toBe(100);
  });

  it("freight: fixed AUD 75 threshold regardless of line value", () => {
    const freightLine: PurchaseOrderLine = {
      line_number: 2,
      description: "Freight",
      quantity_ordered: 1,
      quantity_received: 1,
      unit_price: 500,
      line_total: 500,
      line_type: "freight",
    };
    const result = checkLineTolerance(freightLine, 560); // variance 60, under 75
    expect(result.threshold_applied).toBe(75);
    expect(result.within_tolerance).toBe(true);
  });
});

describe("reconcileThreeWayMatch", () => {
  const validPo: GetPurchaseOrderOutput = {
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
        line_total: 4820.0,
        line_type: "goods",
      },
    ],
    total: 4820.0,
    goods_receipts: [
      { receipt_id: "GR-1", line_number: 1, quantity_received: 100, received_at: new Date().toISOString() },
    ],
    found: true,
  };

  it("FIN-001 known-good case: exact match produces zero variance, no exceptions", () => {
    const result = reconcileThreeWayMatch(validPo, 4820.0);
    expect(result.overall_within_tolerance).toBe(true);
    expect(result.total_calculation.result).toBe(0);
    expect(result.exceptions).toHaveLength(0);
  });

  it("produces a PRICE_VARIANCE exception with expected/observed/threshold when the invoiced amount exceeds line tolerance", () => {
    // PO line total is 4820 (threshold 48.20); invoiced 4900 => variance 80, over threshold
    const result = reconcileThreeWayMatch(validPo, 4900.0);
    expect(result.overall_within_tolerance).toBe(false);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].category).toBe("PRICE_VARIANCE");
    expect(result.exceptions[0].source?.document_id).toBe("FIN-POL-002");
  });

  it("calculation record stores inputs, formula, and result (auditability requirement)", () => {
    const result = reconcileThreeWayMatch(validPo, 4820.0);
    expect(result.total_calculation.inputs).toEqual({ invoiced_total: 4820.0, po_total: 4820.0 });
    expect(result.total_calculation.formula).toBeTruthy();
  });

  it("throws for a multi-line PO when per-line invoiced amounts are not provided, rather than guessing an allocation", () => {
    const multiLinePo: GetPurchaseOrderOutput = {
      ...validPo,
      lines: [
        validPo.lines[0],
        { ...validPo.lines[0], line_number: 2, line_total: 1000, unit_price: 1000, quantity_ordered: 1, quantity_received: 1 },
      ],
      total: 5820,
    };
    expect(() => reconcileThreeWayMatch(multiLinePo, 5820)).toThrow();
  });

  it("resolves per-line correctly for a multi-line PO when invoicedLineTotals is provided", () => {
    const multiLinePo: GetPurchaseOrderOutput = {
      ...validPo,
      lines: [
        validPo.lines[0],
        { ...validPo.lines[0], line_number: 2, line_total: 1000, unit_price: 1000, quantity_ordered: 1, quantity_received: 1 },
      ],
      total: 5820,
    };
    const result = reconcileThreeWayMatch(multiLinePo, 5820, { 1: 4820, 2: 1000 });
    expect(result.overall_within_tolerance).toBe(true);
  });
});

describe("reconcileDuplicates", () => {
  it("FIN-002 known duplicate: an exact match against a paid invoice -> REJECT_DUPLICATE", () => {
    const result = reconcileDuplicates({
      matches: [
        {
          invoice_id: "INV-HIST-0042",
          invoice_reference: "INV-9001",
          amount: 4820,
          currency: "AUD",
          status: "paid",
          match_type: "exact",
        },
      ],
    });
    expect(result.outcome).toBe("REJECT_DUPLICATE");
    expect(result.exceptions[0].category).toBe("DUPLICATE_RISK");
  });

  it("a fuzzy match -> HOLD_FOR_INFORMATION, not an outright rejection", () => {
    const result = reconcileDuplicates({
      matches: [
        {
          invoice_id: "INV-HIST-0099",
          invoice_reference: "INV.9001",
          amount: 4820.02,
          currency: "AUD",
          status: "paid",
          match_type: "fuzzy",
        },
      ],
    });
    expect(result.outcome).toBe("HOLD_FOR_INFORMATION");
  });

  it("no matches -> NONE, no exceptions", () => {
    const result = reconcileDuplicates({ matches: [] });
    expect(result.outcome).toBe("NONE");
    expect(result.exceptions).toHaveLength(0);
  });

  it("an exact match against a HELD (not yet paid/posted) invoice does not trigger REJECT_DUPLICATE", () => {
    const result = reconcileDuplicates({
      matches: [
        {
          invoice_id: "INV-HIST-0050",
          invoice_reference: "INV-9001",
          amount: 4820,
          currency: "AUD",
          status: "held",
          match_type: "exact",
        },
      ],
    });
    expect(result.outcome).not.toBe("REJECT_DUPLICATE");
  });
});

describe("reconcileAuthority", () => {
  it("FIN-001: AUD 4,820 requires only Cost Centre Manager approval, no second approval needed", () => {
    const result = reconcileAuthority(4820, {
      vendorNewerThan30Days: false,
      bankAccountRecentlyChanged: false,
      overseasBankAccount: false,
      manualPayment: false,
      fraudFlag: false,
    });
    expect(result.required_approver).toBe("COST_CENTRE_MANAGER");
    expect(result.requires_second_approval).toBe(false);
  });

  it("AUD 15,000 requires Department Director (exceeds Cost Centre Manager's 10,000 limit)", () => {
    const result = reconcileAuthority(15000, {
      vendorNewerThan30Days: false,
      bankAccountRecentlyChanged: false,
      overseasBankAccount: false,
      manualPayment: false,
      fraudFlag: false,
    });
    expect(result.required_approver).toBe("DEPARTMENT_DIRECTOR");
  });

  it("FIN-003: a recently changed bank account triggers mandatory second approval regardless of amount", () => {
    const result = reconcileAuthority(6200, {
      vendorNewerThan30Days: false,
      bankAccountRecentlyChanged: true,
      overseasBankAccount: false,
      manualPayment: false,
      fraudFlag: false,
    });
    expect(result.requires_second_approval).toBe(true);
    expect(result.second_approval_reason).toMatch(/bank account recently changed/);
  });

  it("a value exactly at a tier boundary (10,000) stays within Cost Centre Manager's limit", () => {
    const result = reconcileAuthority(10000, {
      vendorNewerThan30Days: false,
      bankAccountRecentlyChanged: false,
      overseasBankAccount: false,
      manualPayment: false,
      fraudFlag: false,
    });
    expect(result.required_approver).toBe("COST_CENTRE_MANAGER");
  });

  it("above CFO's 1,000,000 limit requires CEO", () => {
    const result = reconcileAuthority(1_500_000, {
      vendorNewerThan30Days: false,
      bankAccountRecentlyChanged: false,
      overseasBankAccount: false,
      manualPayment: false,
      fraudFlag: false,
    });
    expect(result.required_approver).toBe("CEO");
  });
});
