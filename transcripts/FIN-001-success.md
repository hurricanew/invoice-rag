# Transcript — FIN-001 (successful flow: valid three-way match, full approval cycle)

**Captured**: 2026-09-10, via the real CLI (`npm run cli -- start-run` / `approve` / `get-run`) · **Model**: `amazon.nova-pro-v1:0` via Bedrock `Converse` · **run_id**: `34bbb6c6-5c57-44a4-b790-9ad0e71758e0`

This transcript shows the full orchestrator end to end — the LLM decision, the human approval pause, resolution, submission, and the complete audit trail — not just the recommendation step.

## Case input

```json
{
  "case_id": "FIN-001",
  "invoice_reference": "INV-9101",
  "vendor_id": "VEND-100",
  "amount": 4820.0,
  "currency": "AUD",
  "po_reference": "PO-88213",
  "notes": "Standard invoice against PO-88213, goods received in full."
}
```

## Commands run

```bash
npm run cli -- start-run fixtures/cases/FIN-001.json
# -> status: APPROVAL_REQUIRED

npm run cli -- approve 34bbb6c6-5c57-44a4-b790-9ad0e71758e0
# -> status: COMPLETED

npm run cli -- get-run 34bbb6c6-5c57-44a4-b790-9ad0e71758e0
# -> full result + audit trail below
```

## Final result

```json
{
  "case_id": "FIN-001",
  "run_id": "e6f81455-46f5-447d-8441-722c98b5f6b6",
  "recommendation": "APPROVE_FOR_POSTING",
  "confidence": 0.95,
  "assumptions": [
    "All provided deterministic reconciliation results are accurate and complete."
  ],
  "sourced_facts": [
    { "statement": "A purchase order was found for this invoice.", "source": { "document_id": "FIN-POL-002", "version": "2.4", "page_or_section": "1. Matching basis" } },
    { "statement": "Goods receipt is on file.", "source": { "document_id": "FIN-POL-002", "version": "2.4", "page_or_section": "1. Matching basis" } },
    { "statement": "The invoice is within tolerance.", "source": { "document_id": "FIN-POL-002", "version": "2.4", "page_or_section": "2. Tolerances" } }
  ],
  "calculations": [
    { "label": "line_1_variance", "formula": "abs(invoiced_line_total - po_line_total)", "inputs": { "invoiced_line_total": 4820, "po_line_total": 4820 }, "result": 0, "rounding_method": "none (decimal arithmetic, no rounding applied)" },
    { "label": "document_total_variance", "formula": "abs(invoiced_total - po_total)", "inputs": { "invoiced_total": 4820, "po_total": 4820 }, "result": 0, "rounding_method": "none (decimal arithmetic, no rounding applied)" }
  ],
  "inferences": [
    { "statement": "The invoice is consistent with the purchase order and goods receipt.", "based_on": ["The deterministic reconciliation results show a variance of 0.", "The purchase order and goods receipt are on file."] }
  ],
  "unknowns": [],
  "policy_findings": [
    { "rule": "delegated approval limit", "source": { "document_id": "FIN-POL-003", "version": "4.0", "page_or_section": "2. Standard operating expenditure" }, "compliant": true, "detail": "AUD 4820 requires approval at or above COST_CENTRE_MANAGER level" }
  ],
  "exceptions": [],
  "next_action": "Await approval from COST_CENTRE_MANAGER.",
  "actions_taken": [
    { "action": "Submitted decision: POSTED", "ts": "2026-09-10T05:17:28.879Z", "reference": "PMT-2026-000001" }
  ]
}
```

## Full audit trail (11 events, from `get-run`)

| ts | event | tool/state | outcome | duration_ms |
|---|---|---|---|---|
| 05:17:13.854 | state_entered | RETRIEVE_DOCUMENTS | success | — |
| 05:17:13.859 | tool_call | retrieve_finance_documents | success | 5 |
| 05:17:13.860 | tool_call | check_invoice_history | success | 0 |
| 05:17:13.861 | tool_call | get_vendor_record | success | 1 |
| 05:17:13.861 | tool_call | get_purchase_order | success | 1 |
| 05:17:13.862 | reconciliation | duplicate=NONE, three_way_match_ok=true | success | — |
| 05:17:19.612 | llm_decision | recommendation=APPROVE_FOR_POSTING, attempts=1 | success | — |
| 05:17:19.614 | approval_requested | AWAITING_APPROVAL | success | — |
| 05:17:28.873 | approval_resolved | approve | success | — |
| 05:17:28.879 | tool_call | submit_finance_decision | success | 1 |
| 05:17:28.879 | submission | posting_reference=PMT-2026-000001, idempotent_replay=false | success | — |

Note the ~5.7 second gap between `reconciliation` (05:17:13.862) and `llm_decision` (05:17:19.612) — that's the real Bedrock `Converse` call latency; everything else in the run completes in single-digit milliseconds, since it's local computation.

## Assessment against the spec's expected control behaviour

> "Cite matching evidence, calculate totals, request approval, then submit exactly once."

- ✅ Cites real, correct document IDs and sections for every factual claim
- ✅ Reproduces the deterministic reconciliation's exact numbers (zero variance) rather than recomputing them
- ✅ Correctly stops at `AWAITING_APPROVAL` before any submission
- ✅ **Submits exactly once**: `resolveApproval` calls `submit_finance_decision` with `idempotency_key: run_id`; `actions_taken` shows a single posting entry, `idempotent_replay: false`. See [transcripts/FIN-005-idempotent-replay.md](FIN-005-idempotent-replay.md) for the case where a second approval callback arrives for the same run and is proven not to double-post.
