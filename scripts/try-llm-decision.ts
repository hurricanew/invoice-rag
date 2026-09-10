import { loadCaseFixture, loadVendorFixture, loadPurchaseOrderFixture, loadInvoiceHistory } from "../src/lib/loadFixtures.js";
import { retrieveFinanceDocuments } from "../src/tools/retrieveFinanceDocuments.js";
import { checkInvoiceHistory } from "../src/tools/checkInvoiceHistory.js";
import { reconcileThreeWayMatch } from "../src/lib/reconcileThreeWayMatch.js";
import { reconcileDuplicates } from "../src/lib/reconcileDuplicates.js";
import { reconcileAuthority } from "../src/lib/reconcileAuthority.js";
import { getLLMDecisionWithRepair } from "../src/lib/llmDecisionWithRepair.js";

const caseId = process.argv[2] ?? "FIN-001";

async function main() {
  const { case: caseRequest, scenario } = await loadCaseFixture(caseId);
  console.log(`Running ${caseId}: ${scenario?.name}`);

  const po = caseRequest.po_reference ? await loadPurchaseOrderFixture(caseRequest.po_reference) : null;
  const vendor = await loadVendorFixture(caseRequest.vendor_id);
  const historyResult = await checkInvoiceHistory({
    vendor_id: caseRequest.vendor_id,
    invoice_reference: caseRequest.invoice_reference,
    amount: caseRequest.amount,
    currency: caseRequest.currency,
  });
  const duplicateResult = reconcileDuplicates(historyResult);

  const matchResult = po?.found ? reconcileThreeWayMatch(po, caseRequest.amount) : null;
  const authorityResult = reconcileAuthority(caseRequest.amount, {
    vendorNewerThan30Days: false,
    bankAccountRecentlyChanged: vendor.bank_account_changed_at !== null,
    overseasBankAccount: vendor.payment_details_masked.country !== "AU",
    manualPayment: false,
    fraudFlag: false,
  });

  const retrieval = await retrieveFinanceDocuments({
    query: `${caseRequest.notes ?? ""} three-way match tolerance duplicate invoice vendor bank change approval`,
    top_k: 8,
  });

  const outcome = await getLLMDecisionWithRepair(`try-${caseId}`, {
    caseRequest,
    retrievedChunks: retrieval.chunks,
    matchResult,
    duplicateResult,
    authorityResult,
    poFound: po?.found ?? false,
    hasReceipt: (po?.goods_receipts.length ?? 0) > 0,
  });

  console.log(`Attempts: ${outcome.attempts}, tokens: ${outcome.totalTokens}`);
  console.log(JSON.stringify(outcome.result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
