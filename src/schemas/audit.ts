import { z } from "zod";

// Explicit allowlist: only these fields may ever be written to an audit event.
// A tool response gaining a new field (e.g. a full bank account) must not
// leak into logs just because it exists on the response object — callers
// build this shape by hand, never by spreading a raw tool result.
export const AuditEventSchema = z.object({
  run_id: z.string().min(1),
  event_id: z.string().min(1),
  ts: z.string().datetime(),
  event: z.enum([
    "state_entered",
    "state_exited",
    "tool_call",
    "reconciliation",
    "llm_decision",
    "validation",
    "repair_retry",
    "approval_requested",
    "approval_resolved",
    "submission",
    "run_failed",
  ]),
  state: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  outcome: z.enum(["success", "failure", "timeout", "retried", "skipped"]),
  duration_ms: z.number().nonnegative().optional(),
  correlation_id: z.string().min(1),
  detail: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
