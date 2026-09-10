import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  GetPurchaseOrderInputSchema,
  GetPurchaseOrderOutputSchema,
  type GetPurchaseOrderOutput,
} from "../schemas/tools.js";

// A PO with no fixture file simulates "not found" (FIN-004: missing evidence).
// This resolves with found:false rather than throwing, because a missing PO
// is a legitimate business outcome the reconciliation step must handle
// explicitly (MISSING_PO exception) — not a system failure.
export async function getPurchaseOrder(rawInput: unknown): Promise<GetPurchaseOrderOutput> {
  const input = GetPurchaseOrderInputSchema.parse(rawInput);
  const fixturePath = path.resolve(
    process.cwd(),
    "fixtures",
    "purchase_orders",
    `${input.po_number}.json`,
  );

  let raw: string;
  try {
    raw = await readFile(fixturePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return GetPurchaseOrderOutputSchema.parse({
        po_number: input.po_number,
        currency: "AUD",
        approval_status: "PENDING",
        lines: [],
        total: 0,
        goods_receipts: [],
        found: false,
      });
    }
    throw err;
  }

  return GetPurchaseOrderOutputSchema.parse(JSON.parse(raw));
}
