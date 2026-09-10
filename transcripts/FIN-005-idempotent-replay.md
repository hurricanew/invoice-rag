# Transcript — FIN-005 (duplicate approval callback: idempotency proof)

**Captured**: 2026-09-10, via the real CLI · **Model**: `amazon.nova-pro-v1:0` via Bedrock `Converse` · **run_id**: `01dad9d6-f6ab-49cb-ade6-590ec75266bf`

This is the spec's FIN-005 scenario: "the same approval callback is delivered twice. Produce one effective finance decision and a stable replay-safe response." It demonstrates the idempotency guarantee separately from FIN-001's approval flow, since this is the case designed specifically to exercise it.

## Commands run

```bash
npm run cli -- start-run fixtures/cases/FIN-005.json
# -> status: APPROVAL_REQUIRED, run_id: 01dad9d6-f6ab-49cb-ade6-590ec75266bf

npm run cli -- approve 01dad9d6-f6ab-49cb-ade6-590ec75266bf   # first callback
npm run cli -- approve 01dad9d6-f6ab-49cb-ade6-590ec75266bf   # duplicate callback, same run_id
```

## First `approve` call

Result includes:
```json
"actions_taken": [
  { "action": "Submitted decision: POSTED", "ts": "2026-09-10T05:19:27.141Z", "reference": "PMT-2026-000001" }
]
```

## Second `approve` call (the duplicate callback)

CLI output, verbatim:
```
This decision was already resolved — returning the stored result (replay-safe).
run_id:        01dad9d6-f6ab-49cb-ade6-590ec75266bf
case_id:       FIN-005
status:        COMPLETED
current_state: DONE
```

Result's `actions_taken` on the second call — identical to the first, not a second entry:
```json
"actions_taken": [
  { "action": "Submitted decision: POSTED", "ts": "2026-09-10T05:19:27.141Z", "reference": "PMT-2026-000001" }
]
```

Same timestamp, same posting reference, no second entry appended. Nothing was re-submitted.

## How this is actually guaranteed (not just observed once)

Two independent layers, per [src/lib/runCase.ts](../src/lib/runCase.ts) and [src/tools/submitFinanceDecision.ts](../src/tools/submitFinanceDecision.ts):

1. **`resolveApproval`'s fast path**: if a run's `status` is already `COMPLETED`, it returns the stored result immediately — no tool call is even attempted on the second call. This is what produced the "already resolved" message above.
2. **`submit_finance_decision`'s own idempotency key**: `resolveApproval` always passes `idempotency_key: run_id`. Even if the fast path above didn't exist — say a duplicate callback arrived while the first submission was still in flight — `submitFinanceDecision` checks its ledger for that key first and returns the *original* posting result (`idempotent_replay: true`) rather than creating a second ledger entry. This is the guarantee that actually matters; the fast path is a convenience on top of it.

This is also covered by an automated test — `test/runCase.test.ts`'s "FIN-005: a duplicate approval callback produces one effective decision and a stable replay" asserts `idempotentReplay: true` on the second call and identical `actions_taken` between both calls (part of the 114 unit/contract tests, run with a mocked LLM for determinism; this transcript is the same behavior demonstrated live against a real model).
