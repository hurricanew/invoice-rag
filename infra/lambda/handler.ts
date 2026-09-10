import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { CaseRequestSchema } from "../../src/schemas/case.js";
import { runCase, resolveApproval } from "../../src/lib/runCase.js";
import { getRun, getAuditEvents } from "../../src/lib/runStore.js";
import { runAllEvaluations } from "../../src/lib/evaluations.js";

// Minimal HTTP wrapper around the same runCase/resolveApproval/
// runAllEvaluations functions the CLI uses — no new orchestration logic,
// just routing. Deployed behind a Lambda Function URL for speed (skips
// full API Gateway wiring) under this stage's time budget; swapping in
// API Gateway later is a CDK-only change, this handler is unaffected.
export async function handler(event: any): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  const json = (status: number, body: unknown) => ({
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, null, 2),
  });

  try {
    if (method === "POST" && path === "/runs") {
      const caseRequest = CaseRequestSchema.parse(JSON.parse(event.body ?? "{}"));
      const run = await runCase(caseRequest);
      return json(200, run);
    }

    if (method === "GET" && path.startsWith("/runs/")) {
      const runId = path.split("/")[2];
      const run = await getRun(runId);
      if (!run) return json(404, { error: "run not found" });
      const events = await getAuditEvents(runId);
      return json(200, { ...run, audit_events: events });
    }

    if (method === "POST" && /^\/runs\/[^/]+\/decision$/.test(path)) {
      const runId = path.split("/")[2];
      const { decision } = JSON.parse(event.body ?? "{}");
      const result = await resolveApproval(runId, decision);
      return json(200, result);
    }

    if (method === "GET" && path === "/evaluations") {
      const results = await runAllEvaluations();
      return json(200, results);
    }

    return json(404, { error: "not found" });
  } catch (err: any) {
    return json(500, { error: err.message ?? String(err) });
  }
}
