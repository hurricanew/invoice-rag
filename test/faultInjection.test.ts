import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";

// Isolated data directory per test file — see runCase.test.ts for why.
process.env.RUN_DATA_DIR = "data-test-faultInjection";

// Fault injection at the orchestrator level: each of the tools runCase
// depends on is mocked to fail in a way it would never fail in the happy
// path (thrown error, hang past the timeout), and we assert the
// orchestrator degrades safely every time — no corrupted run record, no
// silent success, no unbounded retry, and a persisted audit trail
// explaining what happened. This exercises the actual failure-handling
// code paths (withTimeoutAndRetry's bounded retry, runCase's top-level
// catch) rather than just the one scenario the non-fault-injection tests
// happen to hit.
vi.mock("../src/tools/getVendorRecord.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/getVendorRecord.js")>(
    "../src/tools/getVendorRecord.js",
  );
  return { ...actual, getVendorRecord: vi.fn(actual.getVendorRecord) };
});
vi.mock("../src/tools/getPurchaseOrder.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/getPurchaseOrder.js")>(
    "../src/tools/getPurchaseOrder.js",
  );
  return { ...actual, getPurchaseOrder: vi.fn(actual.getPurchaseOrder) };
});
vi.mock("../src/tools/checkInvoiceHistory.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/checkInvoiceHistory.js")>(
    "../src/tools/checkInvoiceHistory.js",
  );
  return { ...actual, checkInvoiceHistory: vi.fn(actual.checkInvoiceHistory) };
});
vi.mock("../src/tools/retrieveFinanceDocuments.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/retrieveFinanceDocuments.js")>(
    "../src/tools/retrieveFinanceDocuments.js",
  );
  return { ...actual, retrieveFinanceDocuments: vi.fn(actual.retrieveFinanceDocuments) };
});
vi.mock("../src/lib/llmDecisionWithRepair.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/llmDecisionWithRepair.js")>(
    "../src/lib/llmDecisionWithRepair.js",
  );
  return { ...actual, getLLMDecisionWithRepair: vi.fn() };
});

import { getVendorRecord } from "../src/tools/getVendorRecord.js";
import { getPurchaseOrder } from "../src/tools/getPurchaseOrder.js";
import { checkInvoiceHistory } from "../src/tools/checkInvoiceHistory.js";
import { retrieveFinanceDocuments } from "../src/tools/retrieveFinanceDocuments.js";
import { getLLMDecisionWithRepair } from "../src/lib/llmDecisionWithRepair.js";
import { runCase } from "../src/lib/runCase.js";
import { getAuditEvents, getRun } from "../src/lib/runStore.js";
import { loadCaseFixture } from "../src/lib/loadFixtures.js";

const mockedVendor = vi.mocked(getVendorRecord);
const mockedPO = vi.mocked(getPurchaseOrder);
const mockedHistory = vi.mocked(checkInvoiceHistory);
const mockedRetrieval = vi.mocked(retrieveFinanceDocuments);
const mockedDecision = vi.mocked(getLLMDecisionWithRepair);

const dataDir = path.resolve(process.cwd(), "data-test-faultInjection");

beforeEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  mockedVendor.mockReset();
  mockedPO.mockReset();
  mockedHistory.mockReset();
  mockedRetrieval.mockReset();
  mockedDecision.mockReset();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Injects a permanent failure into exactly one of the three parallel
// tools (or retrieval), letting the others behave normally, and confirms
// the run fails cleanly regardless of WHICH dependency broke.
describe.each([
  { label: "get_vendor_record throws", inject: () => mockedVendor.mockRejectedValue(new Error("vendor service down")) },
  { label: "get_purchase_order throws", inject: () => mockedPO.mockRejectedValue(new Error("PO service down")) },
  { label: "check_invoice_history throws", inject: () => mockedHistory.mockRejectedValue(new Error("history service down")) },
  { label: "retrieve_finance_documents throws", inject: () => mockedRetrieval.mockRejectedValue(new Error("retrieval index down")) },
])("fault injection: $label", ({ inject }) => {
  it("fails the run explicitly with status FAILED, never silently succeeds or corrupts state", async () => {
    // Everything not under fault gets a working default so the failure
    // is isolated to exactly the one injected dependency.
    mockedVendor.mockResolvedValue({
      vendor_id: "VEND-100",
      legal_name: "Acme",
      status: "ACTIVE",
      payment_details_masked: { bank_account_last4: "0000", country: "AU" },
      risk_flags: [],
      bank_account_changed_at: null,
      last_updated: new Date().toISOString(),
    });
    mockedPO.mockResolvedValue({
      po_number: "PO-88213",
      currency: "AUD",
      approval_status: "APPROVED",
      lines: [],
      total: 0,
      goods_receipts: [{ receipt_id: "GR-1", line_number: 1, quantity_received: 1, received_at: new Date().toISOString() }],
      found: true,
    });
    mockedHistory.mockResolvedValue({ matches: [] });
    mockedRetrieval.mockResolvedValue({ chunks: [] });

    inject();

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    // Whichever tool failed, the run must land in an explicit failure
    // state — never IN_PROGRESS forever, never a fabricated COMPLETED.
    expect(run.status).toBe("FAILED");
    expect(run.error).toBeTruthy();
    expect(run.result).toBeNull();

    // The failure must be visible in the audit trail, not swallowed.
    const events = await getAuditEvents(run.run_id);
    expect(events.some((e) => e.outcome === "failure")).toBe(true);

    // A caller re-reading the run gets the SAME failed state back — no
    // race where a second read sees something different.
    const reread = await getRun(run.run_id);
    expect(reread?.status).toBe("FAILED");
    expect(reread?.error).toBe(run.error);
  });
});

describe("fault injection: retry then recover", () => {
  it("a tool that fails twice then succeeds still completes the run correctly (bounded retry absorbs it)", async () => {
    let vendorAttempts = 0;
    mockedVendor.mockImplementation(async () => {
      vendorAttempts += 1;
      if (vendorAttempts <= 2) throw new Error(`transient vendor failure ${vendorAttempts}`);
      return {
        vendor_id: "VEND-100",
        legal_name: "Acme",
        status: "ACTIVE",
        payment_details_masked: { bank_account_last4: "0000", country: "AU" },
        risk_flags: [],
        bank_account_changed_at: null,
        last_updated: new Date().toISOString(),
      };
    });
    mockedPO.mockResolvedValue({
      po_number: "PO-88213",
      currency: "AUD",
      approval_status: "APPROVED",
      lines: [],
      total: 0,
      goods_receipts: [{ receipt_id: "GR-1", line_number: 1, quantity_received: 1, received_at: new Date().toISOString() }],
      found: true,
    });
    mockedHistory.mockResolvedValue({ matches: [] });
    mockedRetrieval.mockResolvedValue({ chunks: [] });
    mockedDecision.mockResolvedValue({
      result: {
        case_id: "FIN-001",
        run_id: "x",
        recommendation: "APPROVE_FOR_POSTING",
        confidence: 0.9,
        assumptions: [],
        sourced_facts: [],
        calculations: [],
        inferences: [],
        unknowns: [],
        policy_findings: [],
        exceptions: [],
        next_action: "approve",
        actions_taken: [],
      },
      attempts: 1,
      totalTokens: 100,
    });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    // withTimeoutAndRetry's default maxRetries (2) absorbs 2 failures + 1
    // success = 3 attempts, so the run should complete normally despite
    // the injected transient failures.
    expect(vendorAttempts).toBe(3);
    expect(run.status).toBe("APPROVAL_REQUIRED");
    expect(run.error).toBeNull();
  });

  it("a tool that fails MORE times than the retry budget allows fails the run, not silently proceeds with stale/default data", async () => {
    mockedVendor.mockRejectedValue(new Error("vendor service permanently down"));
    mockedPO.mockResolvedValue({
      po_number: "PO-88213",
      currency: "AUD",
      approval_status: "APPROVED",
      lines: [],
      total: 0,
      goods_receipts: [{ receipt_id: "GR-1", line_number: 1, quantity_received: 1, received_at: new Date().toISOString() }],
      found: true,
    });
    mockedHistory.mockResolvedValue({ matches: [] });
    mockedRetrieval.mockResolvedValue({ chunks: [] });

    const { case: caseRequest } = await loadCaseFixture("FIN-001");
    const run = await runCase(caseRequest);

    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/vendor service permanently down/);
    // Must not have fabricated a recommendation from partial/missing data.
    expect(run.result).toBeNull();
  });
});
