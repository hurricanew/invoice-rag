import type { PolicyFindingSchema } from "../schemas/result.js";
import { z } from "zod";

type PolicyFinding = z.infer<typeof PolicyFindingSchema>;

export type ApproverRole =
  | "COST_CENTRE_MANAGER"
  | "DEPARTMENT_DIRECTOR"
  | "EXECUTIVE_DIRECTOR"
  | "CFO"
  | "CEO";

// FIN-POL-003 §2: standard operating expenditure limits, in AUD.
const APPROVAL_LIMITS: { role: ApproverRole; max: number }[] = [
  { role: "COST_CENTRE_MANAGER", max: 10_000 },
  { role: "DEPARTMENT_DIRECTOR", max: 50_000 },
  { role: "EXECUTIVE_DIRECTOR", max: 250_000 },
  { role: "CFO", max: 1_000_000 },
  { role: "CEO", max: Infinity },
];

export interface HigherRiskSignals {
  vendorNewerThan30Days: boolean;
  bankAccountRecentlyChanged: boolean;
  overseasBankAccount: boolean;
  manualPayment: boolean;
  fraudFlag: boolean;
}

export interface AuthorityCheckResult {
  required_approver: ApproverRole;
  requires_second_approval: boolean;
  second_approval_reason?: string;
  policy_findings: PolicyFinding[];
}

function minimumApproverFor(amountAud: number): ApproverRole {
  const tier = APPROVAL_LIMITS.find((t) => amountAud <= t.max);
  return tier ? tier.role : "CEO";
}

// FIN-POL-003 §3: a new vendor (<30 days), a changed bank account, an
// overseas account, a manual payment, or a fraud flag each independently
// require a second approval (one approver from Financial Control), on top
// of the normal monetary limit.
export function reconcileAuthority(
  amountAud: number,
  signals: HigherRiskSignals,
): AuthorityCheckResult {
  const requiredApprover = minimumApproverFor(amountAud);

  const triggeredReasons: string[] = [];
  if (signals.vendorNewerThan30Days) triggeredReasons.push("vendor is less than 30 days old");
  if (signals.bankAccountRecentlyChanged) triggeredReasons.push("bank account recently changed");
  if (signals.overseasBankAccount) triggeredReasons.push("overseas bank account");
  if (signals.manualPayment) triggeredReasons.push("manual payment");
  if (signals.fraudFlag) triggeredReasons.push("fraud flag present");

  const requiresSecondApproval = triggeredReasons.length > 0;

  const policyFindings: PolicyFinding[] = [
    {
      rule: "delegated approval limit",
      source: { document_id: "FIN-POL-003", version: "4.0", page_or_section: "2. Standard operating expenditure" },
      compliant: true,
      detail: `AUD ${amountAud} requires approval at or above ${requiredApprover} level`,
    },
  ];

  if (requiresSecondApproval) {
    policyFindings.push({
      rule: "higher-risk transaction — second approval required",
      source: { document_id: "FIN-POL-003", version: "4.0", page_or_section: "3. Higher-risk transactions" },
      compliant: false,
      detail: `Second approval (one from Financial Control) required: ${triggeredReasons.join(", ")}`,
    });
  }

  return {
    required_approver: requiredApprover,
    requires_second_approval: requiresSecondApproval,
    second_approval_reason: requiresSecondApproval ? triggeredReasons.join(", ") : undefined,
    policy_findings: policyFindings,
  };
}
