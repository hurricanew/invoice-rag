import { loadCaseFixture } from "../src/lib/loadFixtures.js";
import { runCase, resolveApproval } from "../src/lib/runCase.js";
import { getAuditEvents } from "../src/lib/runStore.js";

const caseId = process.argv[2] ?? "FIN-001";
const decision = (process.argv[3] as "approve" | "reject" | undefined) ?? "approve";

async function main() {
  const { case: caseRequest } = await loadCaseFixture(caseId);
  console.log(`Running ${caseId} through the orchestrator...`);
  const run = await runCase(caseRequest);
  console.log(`Status: ${run.status}, state: ${run.current_state}`);

  if (run.status === "APPROVAL_REQUIRED") {
    console.log(`Pending approval:`, run.pending_approval);
    console.log(`Resolving with: ${decision}`);
    const { run: resolved, idempotentReplay } = await resolveApproval(run.run_id, decision);
    console.log(`Final status: ${resolved.status}, idempotent_replay: ${idempotentReplay}`);
    console.log(JSON.stringify(resolved.result, null, 2));
  } else {
    console.log(`Error: ${run.error}`);
  }

  const events = await getAuditEvents(run.run_id);
  console.log(`\n${events.length} audit events recorded.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
