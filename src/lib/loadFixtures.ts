import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CaseRequestSchema } from "../schemas/case.js";
import { GetVendorRecordOutputSchema } from "../schemas/tools.js";

const FIXTURES_ROOT = path.resolve(process.cwd(), "fixtures");

export async function loadCaseFixture(caseId: string) {
  const raw = await readFile(path.join(FIXTURES_ROOT, "cases", `${caseId}.json`), "utf-8");
  const parsed = JSON.parse(raw);
  // _scenario is documentation metadata for humans/tests, not part of the
  // tool-facing contract — strip it before schema validation.
  const { _scenario, ...caseInput } = parsed;
  return { case: CaseRequestSchema.parse(caseInput), scenario: _scenario };
}

export async function loadVendorFixture(vendorId: string) {
  const raw = await readFile(path.join(FIXTURES_ROOT, "vendors", `${vendorId}.json`), "utf-8");
  return GetVendorRecordOutputSchema.parse(JSON.parse(raw));
}

export async function loadPurchaseOrderFixture(poNumber: string): Promise<z.infer<
  typeof import("../schemas/tools.js").GetPurchaseOrderOutputSchema
> | null> {
  try {
    const raw = await readFile(
      path.join(FIXTURES_ROOT, "purchase_orders", `${poNumber}.json`),
      "utf-8",
    );
    const { GetPurchaseOrderOutputSchema } = await import("../schemas/tools.js");
    return GetPurchaseOrderOutputSchema.parse(JSON.parse(raw));
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function loadInvoiceHistory() {
  const raw = await readFile(
    path.join(FIXTURES_ROOT, "invoice_history", "paid_invoices.json"),
    "utf-8",
  );
  return JSON.parse(raw) as {
    invoice_id: string;
    vendor_id: string;
    invoice_reference: string;
    amount: number;
    currency: string;
    status: "paid" | "posted" | "held" | "rejected";
    invoice_date: string;
  }[];
}

export const ALL_CASE_IDS = ["FIN-001", "FIN-002", "FIN-003", "FIN-004", "FIN-005"] as const;
