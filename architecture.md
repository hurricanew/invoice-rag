# Architecture — Accounts-Payable RAG Agent

## 1. Overview

An internal accounts-payable assistant that retrieves financial evidence via RAG, reconciles it deterministically, produces a cited recommendation via an LLM, and pauses for human approval before any consequential action. Built on AWS, orchestrated with Step Functions rather than an LLM-driven agent framework, because the tool-invocation sequence is fixed and auditable rather than discovered at runtime. The only point requiring model judgment is the recommendation step itself, isolated as a single Task state — this makes the step/tool-call budget, retry/timeout behavior, and approval pause/resume structural guarantees of the orchestrator rather than emergent properties of prompted agent behavior.

**AWS account:** configured via CLI profile `rag-demo-2`, region `us-east-1`. The account ID itself is not committed anywhere in this repo — set it locally via `.env` (see `.env.example`) or let CDK/CLI resolve it from the profile at run time.

## 2. Components

### API layer
- **API Gateway (HTTP API)** — routes: `POST /runs`, `GET /runs/{id}`, `POST /runs/{id}/decision`, `GET /evaluations`.
- **Start-run Lambda** — validates the incoming case payload against its schema, calls `StartExecution` on the state machine, writes an initial `Runs` record, returns `run_id`.
- **Get-run Lambda** — reads the `Runs` table directly (does not query Step Functions) and returns status, current state, result, and audit events.
- **Approve/reject Lambda** — looks up the stored task token for the run, calls `SendTaskSuccess`/`SendTaskFailure`. If the run's decision is already resolved, returns the stored result instead of re-signaling (idempotent — this is what FIN-005 tests).
- **Evaluations Lambda** — runs the FIN-00X fixtures through the same start-run/get-run/approve path and reports pass/fail per case.

### Orchestration
- **Step Functions (Standard workflow)** — the only place tool-call sequencing and the approval gate are enforced. States: Retrieve documents → Parallel lookups (vendor, PO, invoice history) → Reconcile (deterministic code) → LLM decision (Bedrock + Guardrails) → Validate output (schema + grounding + denied-topics, bounded repair retry, explicit fail) → Choice (consequential?) → Wait for approval (task token) or direct submit → Submit decision → Persist audit trail.
- Chosen over an LLM-driven agent framework (e.g. AWS Strands) because the sequence is fixed; Strands earns its keep if a future version needs open-ended multi-source investigation, which this workflow does not.

### Tools (all mocked for this demo, backed by fixture JSON in DynamoDB or S3)
| Tool | Backing | Notes |
|---|---|---|
| `retrieve_finance_documents` | S3 (corpus) + precomputed embeddings, in-Lambda cosine similarity | Returns ranked chunks with `document_id`, `version`, `status`, relevance score, citation metadata. |
| `get_vendor_record` | DynamoDB fixture table | Status, payment details (masked), risk flags, last-updated timestamp. |
| `get_purchase_order` | DynamoDB fixture table | Lines, totals, currency, tolerances, approval status, goods receipts. |
| `check_invoice_history` | DynamoDB fixture table | Matching invoice references/fingerprints, stable IDs, status. |
| `submit_finance_decision` | DynamoDB (simulated posting) | Deny-by-default, approval-gated, idempotency key required. Never moves real money. |

### Model
- **Bedrock**, model `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region US inference profile — the base model ID does not support on-demand invocation directly), invoked only from the LLM decision state via `Converse` with a Guardrail attached (`guardrailIdentifier`/`guardrailVersion`).
- **Guardrails** config: contextual grounding check (blocks/flags claims inconsistent with retrieved chunks) + denied-topics filter (bypass-approval / disable-verification / skip-policy language) + PII redaction on logged prompts.
- Model ID and Guardrail ID are config, not code — held in SSM Parameter Store, read by the Lambda at cold start.
- No API key to manage — Bedrock auth flows through the Lambda's IAM role (`bedrock:InvokeModel`, `bedrock:ApplyGuardrail`, scoped to the specific model ID and guardrail ID).

### Persistence (DynamoDB)
| Table | Key | Purpose |
|---|---|---|
| `Runs` | `run_id` | status, current_state, typed result, timestamps |
| `AuditEvents` | `run_id` + `sort_key(ts#event_id)` | append-only: tool, outcome, duration_ms, correlation_id |
| `IdempotencyKeys` | `idempotency_key` | decision result cache for `submit_finance_decision` and duplicate approval callbacks |
| `ApprovalTokens` | `run_id` | pending Step Functions task token, cleared on resolution |
| `Fixtures_Vendors`, `Fixtures_PurchaseOrders`, `Fixtures_InvoiceHistory` | entity id | mock system-of-record data for the three lookup tools |

DynamoDB is the source of truth for `GET /runs/{id}` reads (fast, queryable). Step Functions execution history is the durable backstop if the two ever disagree — every state writes its DynamoDB record before advancing so a mid-write crash is caught by Step Functions' own retry rather than silently corrupting the cached status.

### Observability
- **CloudWatch Logs** — structured JSON audit events (`run_id`, `ts`, `event`, `tool`, `outcome`, `duration_ms`, `correlation_id`), written from a single logging helper with an explicit field allowlist so new fields on a tool response don't silently leak sensitive data into logs.
- **Step Functions execution history** — free state-by-state timeline, used as a debugging/trace aid, not the canonical run-status source.
- **X-Ray** — active tracing enabled on the state machine and Lambdas for the latency waterfall (optional extension).

## 3. Trust boundaries

- Retrieved documents and case text are **untrusted data**, never instructions. Enforced two ways: (1) prompt-level framing wraps retrieved chunks in explicit untrusted-data delimiters; (2) structural containment — the model's only output is a JSON recommendation object, it has no code path to invoke `submit_finance_decision` directly, so even a successfully-injected model output cannot bypass the approval gate.
- `submit_finance_decision` independently re-verifies a valid, matching approval record exists in DynamoDB before acting — it does not trust "the state machine reached this state" alone, in case the Lambda is ever invoked outside the workflow.
- Least-authority IAM: each Lambda's role is scoped to only the DynamoDB tables/S3 prefixes it needs; only the LLM-decision Lambda has `bedrock:*` permissions; only `submit_finance_decision`'s Lambda has write access to the simulated posting table.
- Bank account numbers are masked to last-4 everywhere outside the vendor-governance fixture; tax IDs and signatures never enter prompts or logs.

## 4. Failure handling

| Scenario | Handling |
|---|---|
| Tool timeout (FIN-004) | Step Functions `TimeoutSeconds` per Task state, `Catch` routes to bounded retry then a `MISSING_PO`/`MISSING_RECEIPT` exception branch — never silently proceeds to approval. |
| Transient tool failure | Step Functions `Retry` with backoff, distinguished from invalid-output handling (retries are for infra failures, not bad data). |
| Malformed model output | Validate-output state checks schema + Guardrails grounding/denied-topics; up to 2 repair retries (re-prompt with the validation error); still-invalid output routes to an explicit `Fail` state producing a typed error result — never silently trusted. |
| Duplicate approval callback (FIN-005) | `ApprovalTokens` cleared on first resolution; a second `SendTaskSuccess`/`SendTaskFailure` naturally errors, caught and translated into "already resolved," returning the stored result from `IdempotencyKeys`. |
| Application restart/resume | Standard Step Functions executions are durable; `GET /runs/{id}` reads DynamoDB, which reflects true state even if the API layer restarts mid-run. |

## 5. What's real vs. mocked

- **Real**: Bedrock model calls and Guardrails, Step Functions orchestration, DynamoDB persistence, API Gateway, CloudWatch/X-Ray observability.
- **Mocked**: `get_vendor_record`, `get_purchase_order`, `check_invoice_history`, `submit_finance_decision` — all backed by fixture data in DynamoDB, not real ERP/vendor-master/posting systems. Clearly labeled in code and README.
- **Corpus**: the 15-document `finance_rag_corpus` fixture set, embedded once at ingestion time and stored in S3; retrieval is in-Lambda cosine similarity, not a managed vector store (Kendra/OpenSearch would be the production upgrade, noted as a limitation).

## 6. Known limitations (demo scope)

- In-Lambda cosine-similarity retrieval doesn't scale past a small fixed corpus; production would use OpenSearch Serverless or Kendra.
- No multi-region/DR story — single-region demo.
- Guardrails' denied-topics list is a fixed seed set, not tuned against a broad adversarial test suite.
- Token/cost budget enforcement is a simple ceiling check, not a rolling per-tenant budget system.
