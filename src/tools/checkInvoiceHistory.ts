import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CheckInvoiceHistoryInputSchema,
  CheckInvoiceHistoryOutputSchema,
  type CheckInvoiceHistoryInput,
  type CheckInvoiceHistoryOutput,
  type InvoiceHistoryMatch,
} from "../schemas/tools.js";

interface HistoryRecord {
  invoice_id: string;
  vendor_id: string;
  invoice_reference: string;
  amount: number;
  currency: string;
  status: "paid" | "posted" | "held" | "rejected";
  invoice_date: string;
}

function normalizeReference(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isExactMatch(input: CheckInvoiceHistoryInput, record: HistoryRecord): boolean {
  return (
    record.vendor_id === input.vendor_id &&
    normalizeReference(record.invoice_reference) === normalizeReference(input.invoice_reference) &&
    record.currency === input.currency &&
    record.amount === input.amount
  );
}

function isFuzzyMatch(input: CheckInvoiceHistoryInput, record: HistoryRecord): boolean {
  if (record.vendor_id !== input.vendor_id) return false;
  const sameNormalizedRef =
    normalizeReference(record.invoice_reference) === normalizeReference(input.invoice_reference);
  const amountVariancePct = Math.abs(record.amount - input.amount) / input.amount;
  return sameNormalizedRef && amountVariancePct < 0.005 && record.currency === input.currency;
}

export async function checkInvoiceHistory(rawInput: unknown): Promise<CheckInvoiceHistoryOutput> {
  const input = CheckInvoiceHistoryInputSchema.parse(rawInput);
  const fixturePath = path.resolve(
    process.cwd(),
    "fixtures",
    "invoice_history",
    "paid_invoices.json",
  );
  const raw = await readFile(fixturePath, "utf-8");
  const history: HistoryRecord[] = JSON.parse(raw);

  const matches: InvoiceHistoryMatch[] = [];
  for (const record of history) {
    if (isExactMatch(input, record)) {
      matches.push({
        invoice_id: record.invoice_id,
        invoice_reference: record.invoice_reference,
        amount: record.amount,
        currency: record.currency,
        status: record.status,
        match_type: "exact",
        invoice_date: record.invoice_date,
      });
    } else if (isFuzzyMatch(input, record)) {
      matches.push({
        invoice_id: record.invoice_id,
        invoice_reference: record.invoice_reference,
        amount: record.amount,
        currency: record.currency,
        status: record.status,
        match_type: "fuzzy",
        invoice_date: record.invoice_date,
      });
    }
  }

  return CheckInvoiceHistoryOutputSchema.parse({ matches });
}
