#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { CaseRequestSchema } from "../src/schemas/case.js";
import { runCase, resolveApproval, RunNotFoundError, RunNotAwaitingApprovalError } from "../src/lib/runCase.js";
import { getRun, getAuditEvents } from "../src/lib/runStore.js";
import { runAllEvaluations } from "../src/lib/evaluations.js";

function printRunSummary(run: Awaited<ReturnType<typeof getRun>>) {
  if (!run) {
    console.log("Run not found.");
    return;
  }
  console.log(`run_id:        ${run.run_id}`);
  console.log(`case_id:       ${run.case_id}`);
  console.log(`status:        ${run.status}`);
  console.log(`current_state: ${run.current_state}`);
  if (run.error) console.log(`error:         ${run.error}`);
  if (run.token_usage) {
    const t = run.token_usage;
    console.log(
      `token_usage:   ${t.total_tokens} tokens (${t.input_tokens} in / ${t.output_tokens} out), ` +
        `$${t.estimated_cost_usd.toFixed(6)} est.${t.over_budget ? " — OVER BUDGET" : ""}`,
    );
  }
  if (run.pending_approval) {
    console.log(`pending_approval:`);
    console.log(JSON.stringify(run.pending_approval, null, 2));
  }
  if (run.result) {
    console.log(`result:`);
    console.log(JSON.stringify(run.result, null, 2));
  }
}

async function cmdStartRun(caseFilePath: string | undefined) {
  if (!caseFilePath) {
    console.error("Usage: start-run <case.json>");
    process.exitCode = 1;
    return;
  }
  const raw = await readFile(caseFilePath, "utf-8");
  const parsed = JSON.parse(raw);
  const { _scenario, ...caseInput } = parsed;
  const caseRequest = CaseRequestSchema.parse(caseInput);

  const run = await runCase(caseRequest);
  printRunSummary(run);
}

async function cmdGetRun(runId: string | undefined) {
  if (!runId) {
    console.error("Usage: get-run <run_id>");
    process.exitCode = 1;
    return;
  }
  const run = await getRun(runId);
  printRunSummary(run);
  if (run) {
    const events = await getAuditEvents(runId);
    console.log(`\naudit_events (${events.length}):`);
    console.log(JSON.stringify(events, null, 2));
  }
}

async function cmdResolve(decision: "approve" | "reject", runId: string | undefined) {
  if (!runId) {
    console.error(`Usage: ${decision} <run_id>`);
    process.exitCode = 1;
    return;
  }
  try {
    const { run, idempotentReplay } = await resolveApproval(runId, decision);
    if (idempotentReplay) {
      console.log("This decision was already resolved — returning the stored result (replay-safe).");
    }
    printRunSummary(run);
  } catch (err) {
    if (err instanceof RunNotFoundError || err instanceof RunNotAwaitingApprovalError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function cmdListEvaluations() {
  const results = await runAllEvaluations();
  console.log("");
  for (const result of results) {
    const icon = result.overall_pass ? "PASS" : "FAIL";
    console.log(`[${icon}] ${result.case_id} — ${result.scenario} (run_id: ${result.run_id ?? "n/a"})`);
    for (const c of result.checks) {
      const checkIcon = c.pass ? "  ok" : "  X ";
      console.log(`  ${checkIcon} ${c.description}`);
      if (!c.pass) console.log(`       ${c.detail}`);
    }
    console.log("");
  }
  const passCount = results.filter((r) => r.overall_pass).length;
  console.log(`${passCount}/${results.length} cases passed.`);
  if (passCount < results.length) process.exitCode = 1;
}

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "start-run":
      await cmdStartRun(args[0]);
      break;
    case "get-run":
      await cmdGetRun(args[0]);
      break;
    case "approve":
      await cmdResolve("approve", args[0]);
      break;
    case "reject":
      await cmdResolve("reject", args[0]);
      break;
    case "list-evaluations":
      await cmdListEvaluations();
      break;
    default:
      console.log("ap-rag-agent CLI");
      console.log("Usage:");
      console.log("  npm run cli -- start-run <case.json>");
      console.log("  npm run cli -- get-run <run_id>");
      console.log("  npm run cli -- approve <run_id>");
      console.log("  npm run cli -- reject <run_id>");
      console.log("  npm run cli -- list-evaluations");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
