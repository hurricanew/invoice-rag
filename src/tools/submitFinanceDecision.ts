import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  SubmitFinanceDecisionInputSchema,
  SubmitFinanceDecisionOutputSchema,
  type SubmitFinanceDecisionInput,
  type SubmitFinanceDecisionOutput,
} from "../schemas/tools.js";

export class ApprovalRequiredError extends Error {
  constructor() {
    super("submit_finance_decision requires a valid approval_reference; none was provided");
    this.name = "ApprovalRequiredError";
  }
}

interface LedgerEntry extends SubmitFinanceDecisionOutput {
  idempotency_key: string;
  case_id: string;
  decision: SubmitFinanceDecisionInput["decision"];
  submitted_at: string;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const LEDGER_PATH = path.join(DATA_DIR, "ledger.local.json");

async function readLedger(): Promise<LedgerEntry[]> {
  try {
    const raw = await readFile(LEDGER_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeLedger(entries: LedgerEntry[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LEDGER_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

function decisionToStatus(
  decision: SubmitFinanceDecisionInput["decision"],
): SubmitFinanceDecisionOutput["status"] {
  switch (decision) {
    case "APPROVE_FOR_POSTING":
      return "POSTED";
    case "REJECT_DUPLICATE":
    case "REJECT_INVALID":
      return "REJECTED";
    case "HOLD_FOR_INFORMATION":
    case "ESCALATE_CONTROL_REVIEW":
      return "HELD";
  }
}

// Deny-by-default: no approval_reference means this call is rejected outright,
// never simulated as a posting. This is the one tool with a real side effect
// (a simulated ledger write, never real money — see architecture.md §5), so
// it re-verifies approval itself rather than trusting that a caller reached
// this function only after a legitimate approval gate.
export async function submitFinanceDecision(
  rawInput: unknown,
): Promise<SubmitFinanceDecisionOutput> {
  const input: SubmitFinanceDecisionInput = SubmitFinanceDecisionInputSchema.parse(rawInput);

  // Schema already enforces min-length-1, but a whitespace-only string would
  // pass that check while still being no real approval reference — guard
  // against it explicitly here rather than trusting string length alone.
  if (input.approval_reference.trim().length === 0) {
    throw new ApprovalRequiredError();
  }

  const ledger = await readLedger();
  const existing = ledger.find((e) => e.idempotency_key === input.idempotency_key);
  if (existing) {
    return SubmitFinanceDecisionOutputSchema.parse({
      posting_reference: existing.posting_reference,
      status: existing.status,
      idempotent_replay: true,
    });
  }

  const postingReference = `PMT-${new Date().getUTCFullYear()}-${String(ledger.length + 1).padStart(6, "0")}`;
  const entry: LedgerEntry = {
    idempotency_key: input.idempotency_key,
    case_id: input.case_id,
    decision: input.decision,
    posting_reference: postingReference,
    status: decisionToStatus(input.decision),
    idempotent_replay: false,
    submitted_at: new Date().toISOString(),
  };

  await writeLedger([...ledger, entry]);

  return SubmitFinanceDecisionOutputSchema.parse({
    posting_reference: entry.posting_reference,
    status: entry.status,
    idempotent_replay: false,
  });
}
