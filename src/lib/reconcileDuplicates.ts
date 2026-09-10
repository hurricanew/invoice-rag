import type { CheckInvoiceHistoryOutput } from "../schemas/tools.js";
import type { ExceptionSchema } from "../schemas/result.js";
import { z } from "zod";

type Exception = z.infer<typeof ExceptionSchema>;

export type DuplicateOutcome = "REJECT_DUPLICATE" | "HOLD_FOR_INFORMATION" | "NONE";

export interface DuplicateCheckResult {
  outcome: DuplicateOutcome;
  exceptions: Exception[];
}

// FIN-POL-005 §2: an exact match to a paid/posted invoice -> REJECT_DUPLICATE.
// A probable fuzzy match -> HOLD_FOR_INFORMATION, citing both record IDs.
// A prior rejection alone does not prove a new invoice is a duplicate (not
// modeled here since check_invoice_history only returns paid/posted/held/
// rejected matches, and a "rejected" match_type still requires review, not
// an automatic re-rejection).
export function reconcileDuplicates(history: CheckInvoiceHistoryOutput): DuplicateCheckResult {
  const exactMatch = history.matches.find(
    (m) => m.match_type === "exact" && (m.status === "paid" || m.status === "posted"),
  );
  if (exactMatch) {
    return {
      outcome: "REJECT_DUPLICATE",
      exceptions: [
        {
          category: "DUPLICATE_RISK",
          expected: "no exact match against paid/posted invoices",
          observed: `exact match found: ${exactMatch.invoice_id} (status: ${exactMatch.status})`,
          source: {
            document_id: "FIN-POL-005",
            version: "2.8",
            page_or_section: "2. Outcomes",
          },
          owner: "Financial Crime and Controls",
        },
      ],
    };
  }

  const fuzzyMatch = history.matches.find((m) => m.match_type === "fuzzy");
  if (fuzzyMatch) {
    return {
      outcome: "HOLD_FOR_INFORMATION",
      exceptions: [
        {
          category: "DUPLICATE_RISK",
          expected: "no probable fuzzy match against invoice history",
          observed: `fuzzy match found: ${fuzzyMatch.invoice_id} (status: ${fuzzyMatch.status})`,
          source: {
            document_id: "FIN-POL-005",
            version: "2.8",
            page_or_section: "2. Outcomes",
          },
          owner: "Accounts Payable Operations",
        },
      ],
    };
  }

  return { outcome: "NONE", exceptions: [] };
}
