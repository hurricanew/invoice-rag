import { randomUUID } from "node:crypto";
import type { CaseRequest } from "../schemas/case.js";
import { loadVendorFixture, loadPurchaseOrderFixture } from "./loadFixtures.js";
import { retrieveFinanceDocuments } from "../tools/retrieveFinanceDocuments.js";
import { checkInvoiceHistory } from "../tools/checkInvoiceHistory.js";
import { getVendorRecord } from "../tools/getVendorRecord.js";
import { getPurchaseOrder } from "../tools/getPurchaseOrder.js";
import { submitFinanceDecision } from "../tools/submitFinanceDecision.js";
import { reconcileThreeWayMatch, type ThreeWayMatchResult } from "./reconcileThreeWayMatch.js";
import { reconcileDuplicates } from "./reconcileDuplicates.js";
import { reconcileAuthority } from "./reconcileAuthority.js";
import { getLLMDecisionWithRepair, ModelOutputInvalidError } from "./llmDecisionWithRepair.js";
import { withTimeoutAndRetry, ToolTimeoutError } from "./withTimeoutAndRetry.js";
import { createRun, updateRun, appendAuditEvent, getRun } from "./runStore.js";
import type { RunRecord } from "../schemas/run.js";

const TOOL_TIMEOUT_MS = 5000;
const TOOL_MAX_RETRIES = 2;

// Decisions the spec treats as "consequential" — anything other than a plain
// hold requires human sign-off before submit_finance_decision is called.
// HOLD_FOR_INFORMATION does not submit at all (it's a stop, not an action),
// so it is excluded from the approval gate rather than auto-approved.
const CONSEQUENTIAL_DECISIONS = new Set([
  "APPROVE_FOR_POSTING",
  "REJECT_DUPLICATE",
  "REJECT_INVALID",
  "ESCALATE_CONTROL_REVIEW",
]);

async function logEvent(
  runId: string,
  correlationId: string,
  fields: Parameters<typeof appendAuditEvent>[0] extends infer T
    ? Omit<T, "run_id" | "correlation_id">
    : never,
) {
  await appendAuditEvent({ run_id: runId, correlation_id: correlationId, ...fields } as any);
}

async function callTool<T>(
  runId: string,
  correlationId: string,
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await withTimeoutAndRetry(fn, {
      timeoutMs: TOOL_TIMEOUT_MS,
      maxRetries: TOOL_MAX_RETRIES,
      toolName,
    });
    await logEvent(runId, correlationId, {
      event: "tool_call",
      tool: toolName,
      outcome: "success",
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    const outcome = err instanceof ToolTimeoutError ? "timeout" : "failure";
    await logEvent(runId, correlationId, {
      event: "tool_call",
      tool: toolName,
      outcome,
      duration_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function runCase(caseRequest: CaseRequest): Promise<RunRecord> {
  const run = await createRun(caseRequest.case_id);
  const correlationId = randomUUID();

  try {
    await logEvent(run.run_id, correlationId, {
      event: "state_entered",
      state: "RETRIEVE_DOCUMENTS",
      outcome: "success",
    });

    const retrieval = await callTool(run.run_id, correlationId, "retrieve_finance_documents", () =>
      retrieveFinanceDocuments({
        query: `${caseRequest.notes ?? ""} three-way match tolerance duplicate invoice vendor bank change approval`,
        top_k: 8,
      }),
    );

    await updateRun(run.run_id, { current_state: "PARALLEL_LOOKUPS" });
    const [vendor, po, historyResult] = await Promise.all([
      callTool(run.run_id, correlationId, "get_vendor_record", () =>
        getVendorRecord({ vendor_id: caseRequest.vendor_id }),
      ),
      caseRequest.po_reference
        ? callTool(run.run_id, correlationId, "get_purchase_order", () =>
            getPurchaseOrder({ po_number: caseRequest.po_reference! }),
          )
        : Promise.resolve(null),
      callTool(run.run_id, correlationId, "check_invoice_history", () =>
        checkInvoiceHistory({
          vendor_id: caseRequest.vendor_id,
          invoice_reference: caseRequest.invoice_reference,
          amount: caseRequest.amount,
          currency: caseRequest.currency,
        }),
      ),
    ]);

    // Missing PO / missing receipt: PO-backed invoices require both,
    // per FIN-POL-002 section 4 ("invoice without a required receipt
    // cannot be approved for payment"). This is an explicit exit, not
    // something silently absorbed by the LLM decision step.
    const poRequired = caseRequest.po_reference !== undefined;
    const poFound = po?.found ?? false;
    const hasReceipt = (po?.goods_receipts.length ?? 0) > 0;

    if (poRequired && !poFound) {
      await logEvent(run.run_id, correlationId, {
        event: "state_entered",
        state: "MISSING_PO",
        outcome: "failure",
        detail: `Purchase order ${caseRequest.po_reference} not found`,
      });
      return updateRun(run.run_id, {
        status: "COMPLETED",
        current_state: "MISSING_PO",
        result: null,
        error: `Purchase order ${caseRequest.po_reference} not found — cannot verify three-way match. Held for information, not eligible for payment approval.`,
      });
    }
    if (poRequired && poFound && !hasReceipt) {
      await logEvent(run.run_id, correlationId, {
        event: "state_entered",
        state: "MISSING_RECEIPT",
        outcome: "failure",
        detail: `No goods receipt on file for ${caseRequest.po_reference}`,
      });
      return updateRun(run.run_id, {
        status: "COMPLETED",
        current_state: "MISSING_RECEIPT",
        result: null,
        error: `No goods receipt on file for ${caseRequest.po_reference} — invoice cannot be approved for payment without confirmed receipt (FIN-POL-002 section 4).`,
      });
    }

    await updateRun(run.run_id, { current_state: "RECONCILE" });
    const duplicateResult = reconcileDuplicates(historyResult);
    const matchResult: ThreeWayMatchResult | null =
      po?.found ? reconcileThreeWayMatch(po, caseRequest.amount) : null;
    const authorityResult = reconcileAuthority(caseRequest.amount, {
      vendorNewerThan30Days: false,
      bankAccountRecentlyChanged: vendor.bank_account_changed_at !== null,
      overseasBankAccount: vendor.payment_details_masked.country !== "AU",
      manualPayment: false,
      fraudFlag: vendor.risk_flags.length > 0,
    });
    await logEvent(run.run_id, correlationId, {
      event: "reconciliation",
      outcome: "success",
      detail: `duplicate=${duplicateResult.outcome}, three_way_match_ok=${matchResult?.overall_within_tolerance ?? "n/a"}`,
    });

    await updateRun(run.run_id, { current_state: "LLM_DECISION" });
    let outcome;
    try {
      outcome = await getLLMDecisionWithRepair(run.run_id, {
        caseRequest,
        retrievedChunks: retrieval.chunks,
        matchResult,
        duplicateResult,
        authorityResult,
        poFound,
        hasReceipt,
      });
    } catch (err) {
      if (err instanceof ModelOutputInvalidError) {
        await logEvent(run.run_id, correlationId, {
          event: "run_failed",
          state: "MODEL_OUTPUT_INVALID",
          outcome: "failure",
          detail: err.message,
        });
        return updateRun(run.run_id, {
          status: "FAILED",
          current_state: "MODEL_OUTPUT_INVALID",
          error: err.message,
        });
      }
      throw err;
    }
    await logEvent(run.run_id, correlationId, {
      event: "llm_decision",
      outcome: "success",
      detail: `recommendation=${outcome.result.recommendation}, attempts=${outcome.attempts}`,
    });

    await updateRun(run.run_id, { current_state: "VALIDATE_OUTPUT", result: outcome.result });

    const isConsequential = CONSEQUENTIAL_DECISIONS.has(outcome.result.recommendation);
    if (!isConsequential) {
      // HOLD_FOR_INFORMATION: stop here, no submission, no approval needed.
      await logEvent(run.run_id, correlationId, {
        event: "state_exited",
        state: "DONE",
        outcome: "success",
      });
      return updateRun(run.run_id, { status: "COMPLETED", current_state: "DONE" });
    }

    await logEvent(run.run_id, correlationId, {
      event: "approval_requested",
      state: "AWAITING_APPROVAL",
      outcome: "success",
    });
    return updateRun(run.run_id, {
      status: "APPROVAL_REQUIRED",
      current_state: "AWAITING_APPROVAL",
      pending_approval: {
        run_id: run.run_id,
        case_id: caseRequest.case_id,
        recommendation: outcome.result.recommendation,
        amount: caseRequest.amount,
        currency: caseRequest.currency,
        vendor_id: caseRequest.vendor_id,
        exceptions_summary: outcome.result.exceptions.map((e) => `${e.category}: ${e.observed}`),
        requested_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    await logEvent(run.run_id, correlationId, {
      event: "run_failed",
      outcome: "failure",
      detail: err instanceof Error ? err.message : String(err),
    });
    return updateRun(run.run_id, {
      status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`No run found with id ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class RunNotAwaitingApprovalError extends Error {
  constructor(public readonly runId: string, public readonly status: string) {
    super(`Run ${runId} is not awaiting approval (status: ${status})`);
    this.name = "RunNotAwaitingApprovalError";
  }
}

export interface ResolveApprovalResult {
  run: RunRecord;
  idempotentReplay: boolean;
}

// Resolves a pending approval and resumes the run to submission. Called
// twice with the same runId (FIN-005's duplicate-callback scenario): the
// second call finds the run already COMPLETED and returns the stored
// result unchanged rather than re-submitting — submit_finance_decision's
// own idempotency key is the actual guarantee here, this check is a fast
// path that avoids a redundant tool call.
export async function resolveApproval(
  runId: string,
  decision: "approve" | "reject",
): Promise<ResolveApprovalResult> {
  const run = await getRun(runId);
  if (!run) throw new RunNotFoundError(runId);

  if (run.status === "COMPLETED") {
    return { run, idempotentReplay: true };
  }
  if (run.status !== "APPROVAL_REQUIRED" || !run.pending_approval || !run.result) {
    throw new RunNotAwaitingApprovalError(runId, run.status);
  }

  const correlationId = randomUUID();
  await logEvent(runId, correlationId, {
    event: "approval_resolved",
    outcome: "success",
    detail: decision,
  });

  if (decision === "reject") {
    const rejected = await updateRun(runId, {
      status: "COMPLETED",
      current_state: "DONE",
      pending_approval: null,
    });
    return { run: rejected, idempotentReplay: false };
  }

  await updateRun(runId, { current_state: "SUBMIT_DECISION" });
  const submission = await callTool(runId, correlationId, "submit_finance_decision", () =>
    submitFinanceDecision({
      run_id: runId,
      case_id: run.case_id,
      decision: run.result!.recommendation as any,
      amount: run.pending_approval!.amount,
      currency: run.pending_approval!.currency,
      idempotency_key: runId,
      approval_reference: `approved-${runId}`,
    }),
  );
  await logEvent(runId, correlationId, {
    event: "submission",
    outcome: "success",
    detail: `posting_reference=${submission.posting_reference}, idempotent_replay=${submission.idempotent_replay}`,
  });

  const updatedResult = {
    ...run.result!,
    actions_taken: [
      ...run.result!.actions_taken,
      {
        action: `Submitted decision: ${submission.status}`,
        ts: new Date().toISOString(),
        reference: submission.posting_reference,
      },
    ],
  };

  const finalRun = await updateRun(runId, {
    status: "COMPLETED",
    current_state: "DONE",
    pending_approval: null,
    result: updatedResult,
  });
  return { run: finalRun, idempotentReplay: submission.idempotent_replay };
}
