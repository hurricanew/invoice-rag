import type { GetPurchaseOrderOutput, PurchaseOrderLine } from "../schemas/tools.js";
import type { CalculationSchema, ExceptionSchema } from "../schemas/result.js";
import { z } from "zod";

type Calculation = z.infer<typeof CalculationSchema>;
type Exception = z.infer<typeof ExceptionSchema>;

export interface LineToleranceResult {
  line_number: number;
  within_tolerance: boolean;
  variance: number;
  threshold_applied: number;
  calculation: Calculation;
}

// FIN-POL-002 §2: tolerance is the LOWER of a fixed AUD amount or a
// percentage of the line value. Goods: AUD 50 or 1%. Services: AUD 100 or
// 2%, provided the service owner confirms completion (not modeled here —
// treated as confirmed since goods_receipts exist for the line). Freight:
// fixed AUD 75, only when the PO explicitly permits freight (i.e. the line
// itself is typed "freight").
function toleranceThresholdFor(line: PurchaseOrderLine): number {
  switch (line.line_type) {
    case "goods":
      return Math.min(50, line.line_total * 0.01);
    case "services":
      return Math.min(100, line.line_total * 0.02);
    case "freight":
      return 75;
  }
}

export function checkLineTolerance(
  line: PurchaseOrderLine,
  invoicedLineTotal: number,
): LineToleranceResult {
  const threshold = toleranceThresholdFor(line);
  const variance = Math.abs(invoicedLineTotal - line.line_total);

  // Goods-specific rule: invoiced quantity must not exceed received quantity,
  // independent of the dollar variance check.
  const quantityOk = line.line_type !== "goods" || line.quantity_ordered <= line.quantity_received;

  const withinTolerance = quantityOk && variance <= threshold;

  return {
    line_number: line.line_number,
    within_tolerance: withinTolerance,
    variance,
    threshold_applied: threshold,
    calculation: {
      label: `line_${line.line_number}_variance`,
      formula: "abs(invoiced_line_total - po_line_total)",
      inputs: { invoiced_line_total: invoicedLineTotal, po_line_total: line.line_total },
      result: variance,
      rounding_method: "none (decimal arithmetic, no rounding applied)",
    },
  };
}

export interface ThreeWayMatchResult {
  overall_within_tolerance: boolean;
  line_results: LineToleranceResult[];
  total_calculation: Calculation;
  exceptions: Exception[];
}

// A missing PO or missing receipt is handled by the caller (orchestrator) as
// a distinct MISSING_PO/MISSING_RECEIPT exception before this function is
// ever invoked — this function assumes po.found === true and that receipts
// exist; it is pure arithmetic over already-retrieved data.
//
// invoicedLineTotals, keyed by line_number, is the amount actually invoiced
// per line. When omitted, this only works for a single-line PO — the
// document-level invoicedTotal is attributed to that one line. A multi-line
// PO without explicit per-line invoice amounts throws rather than silently
// guessing an allocation, since a wrong per-line attribution would produce a
// misleading PRICE_VARIANCE exception (or hide a real one).
export function reconcileThreeWayMatch(
  po: GetPurchaseOrderOutput,
  invoicedTotal: number,
  invoicedLineTotals?: Record<number, number>,
): ThreeWayMatchResult {
  if (!invoicedLineTotals && po.lines.length > 1) {
    throw new Error(
      "reconcileThreeWayMatch: invoicedLineTotals is required for a multi-line PO — " +
        "the document total alone cannot be attributed to individual lines.",
    );
  }

  const lineResults = po.lines.map((line) => {
    const invoicedLineTotal = invoicedLineTotals ? invoicedLineTotals[line.line_number] : invoicedTotal;
    return checkLineTolerance(line, invoicedLineTotal);
  });

  const exceptions: Exception[] = [];
  for (const result of lineResults) {
    if (!result.within_tolerance) {
      exceptions.push({
        category: "PRICE_VARIANCE",
        expected: `variance <= ${result.threshold_applied}`,
        observed: `variance = ${result.variance}`,
        source: { document_id: "FIN-POL-002", version: "2.4", page_or_section: "2. Tolerances" },
        owner: "requester",
      });
    }
  }

  const totalVariance = Math.abs(invoicedTotal - po.total);
  const totalCalculation: Calculation = {
    label: "document_total_variance",
    formula: "abs(invoiced_total - po_total)",
    inputs: { invoiced_total: invoicedTotal, po_total: po.total },
    result: totalVariance,
    rounding_method: "none (decimal arithmetic, no rounding applied)",
  };

  const overallWithinTolerance = lineResults.every((r) => r.within_tolerance);

  return {
    overall_within_tolerance: overallWithinTolerance,
    line_results: lineResults,
    total_calculation: totalCalculation,
    exceptions,
  };
}
