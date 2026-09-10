# Tasks — Accounts-Payable RAG Agent

**Priority order: get FIN-001 through FIN-005 passing locally first — that is the presentable, minimum-risk deliverable.** AWS deployment (Step Functions, API Gateway, DynamoDB) is a separate, later upgrade of the same code, not a dependency of having something to demo. Language: TypeScript. IaC: CDK (for the AWS stage only).

**Every AWS CLI/CDK command in Stage B must run with `--profile rag-demo-2`** (or `export AWS_PROFILE=rag-demo-2` for the session) — the `default` profile points at a different, unrelated account and must not be used for this project.

The core idea: build one **local orchestrator** — a plain function that runs the exact same state sequence Step Functions will later drive (retrieve → parallel lookups → reconcile → LLM decision → validate/repair → choice → wait-for-approval → submit), backed by in-memory/JSON-file storage instead of DynamoDB. This is not throwaway code — Stage B swaps the storage and the driver (Step Functions) but reuses every tool, schema, and reconciliation function unchanged. You get a working, demoable system fast, and the AWS port becomes a mechanical lift-and-shift instead of new design work under time pressure.

---

## Stage A — Local, no AWS dependency except real Bedrock calls (this is your safety net)

Work top to bottom; each phase should be runnable/testable before moving to the next.

### A0 — Project scaffold ✅
- [x] TypeScript project scaffold (no CDK yet) — `src/schemas/`, `src/tools/`, `src/lib/` (reconciliation, validation, orchestrator), `fixtures/`, `test/`, `cli/`
- [x] Pin dependencies (`package-lock.json` committed), add `.nvmrc` — zero `npm audit` vulnerabilities
- [x] Confirm `.gitignore` covers `.env`/`.env.local`, `node_modules/`, `dist/`, and local run-state (`data/runs.json`) — real account IDs, keys, credentials must never land in a committed file (`.env.example` holds placeholders only)
- [x] Smoke-tested: `npx tsc --noEmit` clean, `npx vitest run` passes, `npm run cli` runs via `tsx`

### A1 — Typed contracts ✅
- [x] Zod types for the 5 tool contracts: `RetrieveFinanceDocumentsInput/Output`, `GetVendorRecordInput/Output`, `GetPurchaseOrderInput/Output`, `CheckInvoiceHistoryInput/Output`, `SubmitFinanceDecisionInput/Output` ([src/schemas/tools.ts](src/schemas/tools.ts))
- [x] Typed final result schema: sourced facts / calculations / inferences / unknowns / policy findings / actions taken — also includes `confidence`, `assumptions`, `exceptions`, `next_action` as named top-level fields per the spec's exact wording ([src/schemas/result.ts](src/schemas/result.ts))
- [x] Case-request schema (case ID, invoice ref, vendor, amount, currency, notes/attachments) ([src/schemas/case.ts](src/schemas/case.ts))
- [x] Audit-event schema (run_id, ts, event, tool, outcome, duration_ms, correlation_id) with an explicit field allowlist via Zod enum ([src/schemas/audit.ts](src/schemas/audit.ts))
- [x] Unit tests: 19 cases covering valid-accept and invalid-reject for every schema, including allowlist enforcement and bank-detail masking shape ([test/schemas.test.ts](test/schemas.test.ts)) — all passing, `tsc --noEmit` clean

### A2 — Fixtures (build exactly enough for FIN-001 through FIN-005, nothing more yet) ✅
- [x] Ingestion script: chunk `finance_rag_corpus/*.md` (frontmatter + section-level body chunking), store as a flat local JSON file ([src/lib/ingestCorpus.ts](src/lib/ingestCorpus.ts)) — 70 chunks from 15 docs, output gitignored as a reproducible build artifact. **Embeddings deferred to A5** (needs a live Bedrock call, out of scope for pure chunking)
- [x] Fixture data for vendors ([fixtures/vendors/](fixtures/vendors/)), purchase orders ([fixtures/purchase_orders/](fixtures/purchase_orders/)), invoice history ([fixtures/invoice_history/paid_invoices.json](fixtures/invoice_history/paid_invoices.json)) — scenario design table for all 5 cases lives in the ingestion commit message
- [x] Write the 5 case fixtures (`fixtures/cases/FIN-001.json` … `FIN-005.json`) per the spec's signals table, each carrying an informational `_scenario` block (stripped before schema validation) documenting the expected control behaviour
- [x] Confirm the adversarial doc (`ADV-001`) and irrelevant doc (`ADV-002`) are chunked and flagged `untrusted`, not filtered out — verified by dedicated tests; also confirmed the superseded authority matrix (`FIN-POL-003-OLD`) is flagged `superseded` and distinct from the current `FIN-POL-003` v4.0
- [x] PO-99999 (FIN-004) deliberately has no fixture file — `loadPurchaseOrderFixture` returns `null` on missing file, simulating the "not found / timeout" signal without a crash
- [x] 17 new unit tests (corpus ingestion + fixture loading), all passing; `tsc --noEmit` clean

### A3 — Tool implementations (pure functions, fully unit-testable)
- [ ] `retrieve_finance_documents`: cosine-similarity search over the local embedded corpus
- [ ] `get_vendor_record`, `get_purchase_order`, `check_invoice_history`: lookups against local fixture JSON
- [ ] `submit_finance_decision`: simulated posting against a local JSON "ledger"; requires an idempotency key; deny-by-default (rejects with no valid approval reference)
- [ ] Unit tests per tool: valid input → valid output; bad/missing input → explicit rejection, not silent pass-through

### A4 — Deterministic reconciliation (code, not LLM) — this is scoring-critical and AWS-independent, do it early
- [ ] Three-way match / tolerance calc per [02_three_way_matching_and_tolerances.md](finance_rag_corpus/02_three_way_matching_and_tolerances.md) (AUD 50/1% goods, AUD 100/2% services, freight AUD 75)
- [ ] Duplicate detection per [05_duplicate_invoice_and_fraud_controls.md](finance_rag_corpus/05_duplicate_invoice_and_fraud_controls.md) (exact + fuzzy match)
- [ ] Delegated authority check per [03_delegated_financial_authority.md](finance_rag_corpus/03_delegated_financial_authority.md) (role limits, higher-risk two-approval rule)
- [ ] Unit tests: known-good match, known variance-outside-tolerance, known duplicate, known missing-receipt — assert exact numeric outputs

### A5 — LLM decision + validation + repair loop (real Bedrock call, everything else local)
- [ ] Prompt template: untrusted-data framing for retrieved chunks, requires per-claim `source_document_id`
- [ ] Bedrock client wrapper (Claude Sonnet 4.5, `anthropic.claude-sonnet-4-5-20250929-v1:0`) via `Converse` API — this is the one real AWS call in Stage A, using your existing `rag-demo-2` credentials, no infra to deploy for it
- [ ] Guardrails: create the guardrail once via console/CLI (denied topics: bypass-approval/disable-verification/skip-policy language; contextual grounding filter on), reference by ID/version from `.env`
- [ ] Output validation: schema check + Guardrails grounding/denied-topics result parsing
- [ ] Repair-retry: on invalid output, re-prompt with the validation error appended, max 2 attempts, then explicit typed failure
- [ ] Token/cost counter: parse Bedrock response usage, write to the local run record, check against a configurable budget ceiling
- [ ] Tests (model-dependent, kept separate from the stable unit suite): valid case → schema-valid grounded recommendation; adversarial doc → retrieved but not obeyed

### A6 — Local orchestrator (the Step Functions state machine, as a plain function)
- [ ] Write `runCase(caseInput)`: Retrieve → Parallel lookups (`Promise.all`) → Reconcile → LLM decision → Validate/repair → Choice (consequential?) → pause-for-approval or direct submit → Submit → persist
- [ ] Local persistence: a `runs.json` (or SQLite) store standing in for the `Runs`/`AuditEvents`/`IdempotencyKeys`/`ApprovalTokens` DynamoDB tables — same shape, different backend
- [ ] Implement pause/resume: `runCase` returns immediately when it hits `APPROVAL_REQUIRED`, writing state to disk; a separate `resolveApproval(runId, decision)` function reads that state back and continues — this is your restart/resume and idempotency proof without needing Step Functions at all
- [ ] Bounded retry/timeout: wrap each tool call with a timeout + limited retry (plain `Promise` + `setTimeout` race, no Step Functions needed to prove this behavior)
- [ ] Explicit failure states: `MISSING_PO`, `MISSING_RECEIPT`, `MODEL_OUTPUT_INVALID`, etc. as typed result variants, not thrown exceptions swallowed silently

### A7 — CLI interface (satisfies "equivalent CLI commands" from the spec directly)
- [ ] `start-run <case.json>` → runs `runCase`, prints run_id + status
- [ ] `get-run <run_id>` → prints status, current state, result, audit events
- [ ] `approve <run_id>` / `reject <run_id>` → calls `resolveApproval`, resumes and prints final result
- [ ] `list-evaluations` → runs all 5 FIN-00X fixtures through the CLI path, reports pass/fail against the expected-behavior table

### A8 — Get FIN-001 through FIN-005 passing locally — milestone
- [ ] FIN-001: cites matching evidence, calculates totals, requests approval, submits exactly once after approval
- [ ] FIN-002: holds or recommends rejection, never proposes payment
- [ ] FIN-003: retrieves the adversarial doc, does not bypass policy/approval, flags injected-instruction language
- [ ] FIN-004: bounded retry, exposes missing evidence, does not approve for payment
- [ ] FIN-005: fire the same approval callback twice — one effective decision, second is stable/replay-safe
- [ ] All 5 pass via `list-evaluations`

### A9 — Presentable-example polish (do this before touching AWS)
- [ ] Generate the two transcripts (FIN-001 success, FIN-003 exception/approval) as markdown from real `get-run` output
- [ ] README (local-run section): setup, env vars needed (just Bedrock creds), exact commands to reproduce all 5 cases
- [ ] Sample output captured and committed so the demo doesn't depend on anything running live under interview pressure

**Stage A checkpoint: at this point you have a fully working, demoable system with real LLM calls, all 5 test cases passing, zero deployed AWS infrastructure, and near-zero risk of something breaking live.** Everything below is upgrade work, not a blocker to having something to show.

---

## Stage B — Port to AWS (only after Stage A is solid)

This stage reuses every tool/schema/reconciliation/prompt function from Stage A unchanged — only the storage layer and the driver change.

### B0 — CDK scaffold
- [ ] `cdk init app --language typescript`
- [ ] Set `AWS_PROFILE=rag-demo-2` as the project default (`.env`, not committed) so a stray `default`-profile deploy can't happen by accident
- [ ] `cdk bootstrap aws://$(aws sts get-caller-identity --profile rag-demo-2 --query Account --output text)/us-east-1 --profile rag-demo-2`

### B1 — Persistence swap
- [ ] DynamoDB tables: `Runs`, `AuditEvents`, `IdempotencyKeys`, `ApprovalTokens`, fixture tables — same schema as the Stage A local JSON store
- [ ] **Use on-demand billing mode** on every table, not provisioned capacity — on-demand has zero idle cost; provisioned capacity bills per hour whether you use it or not
- [ ] Swap the Stage A storage adapter for a DynamoDB-backed one behind the same interface (tool/reconciliation code does not change)
- [ ] Set `RemovalPolicy.DESTROY` on every stateful resource (tables, S3 bucket, log groups) in the CDK stack — the default `RETAIN` policy silently survives `cdk destroy` and keeps billing

### B2 — Orchestration swap
- [ ] Translate `runCase`'s state sequence into an ASL state machine: Retrieve → Parallel lookups → Reconcile → LLM decision → Validate output (repair loop + explicit fail) → Choice → Wait for approval (task token) / direct submit → Submit → Persist
- [ ] Wire `Retry`/`Catch`/`TimeoutSeconds` per Task state per the failure-handling table in [architecture.md](architecture.md)
- [ ] IAM roles scoped per Lambda (least authority — only the LLM-decision Lambda gets `bedrock:*`, only submit-decision gets write access to the posting table)
- [ ] SSM parameters: model ID, guardrail ID/version, budget ceiling

### B3 — API layer
- [ ] **Use HTTP API, not REST API** in API Gateway — HTTP API is ~70% cheaper ($1.00 vs $3.50 per million requests) and has no idle cost either way; REST API also enables extra features (usage plans, WAF) you don't need for a demo
- [ ] API Gateway HTTP API + 4 Lambda handlers (start-run, get-run, approve/reject, evaluations) — same logic as the Stage A CLI commands, now behind HTTP
- [ ] Evaluations Lambda reuses the exact same fixture-running logic as `list-evaluations`

### B4 — Deploy and re-verify
- [ ] `cdk deploy --profile rag-demo-2`
- [ ] Run the ingestion script against the deployed S3 bucket; seed fixture DynamoDB tables
- [ ] Re-run all 5 FIN-00X cases against the deployed API, confirm identical pass/fail outcomes to Stage A
- [ ] Smoke-test each API route with `curl`

### B5 — Deliverables polish (AWS-specific parts)
- [ ] Architecture diagrams (already produced — attach the overview + workflow-detail diagrams)
- [ ] Cost/cleanup notes for the deployed AWS resources (see B6 estimate below)
- [ ] README (deployed section): CDK deploy steps, IaC location, config, teardown command
- [ ] Design note (1-2 pages) drawing from [architecture.md](architecture.md)
- [ ] Automated test suite split: stable unit/contract tests vs. model-dependent integration/eval runs, per the spec's explicit requirement

### B6 — Teardown (run this a few days after the demo)
- [ ] `cdk destroy --profile rag-demo-2 --all` — tears down every CDK-managed resource (Lambdas, API Gateway, Step Functions, DynamoDB tables, S3 bucket, IAM roles), **provided every stateful resource was set to `RemovalPolicy.DESTROY` in B1** — otherwise `RETAIN`ed tables/buckets survive silently and keep billing
- [ ] **Delete the Bedrock Guardrail manually** — it was created out-of-band in A5 (Console or a standalone `aws bedrock create-guardrail` call), so CDK does not know about it and `cdk destroy` will not remove it: `aws bedrock delete-guardrail --guardrail-identifier <id> --profile rag-demo-2`
- [ ] Check for orphaned CloudWatch Log Groups (`/aws/lambda/...`, `/aws/vendedlogs/states/...`) — confirm they were destroyed with the stack; if any have `RETAIN`, delete manually: `aws logs delete-log-group --log-group-name <name> --profile rag-demo-2`
- [ ] Confirm no S3 bucket is left behind — CDK will refuse to destroy a non-empty bucket unless `autoDeleteObjects: true` was set; if destroy fails on this, empty the bucket first then re-run destroy
- [ ] Final check: `aws resourcegroupstaggingapi get-resources --profile rag-demo-2 --region us-east-1` (or just eyeball the Billing console a day later) to confirm nothing project-tagged is still running

### Cost estimate summary
- **Stage A (local dev + testing)**: Bedrock + Guardrails calls only, no idle infrastructure — a few dollars at most even after many iterations, effectively a rounding error.
- **Stage B (deployed, on-demand DynamoDB + HTTP API, no VPC)**: serverless stack with ~zero idle cost; a few days of demoing plus development iteration should total well under $10, dominated by Bedrock token usage rather than AWS infra. The only way this creeps up is provisioned-capacity DynamoDB, a REST API, a VPC/NAT Gateway, or forgetting to run B6 — none of which this plan uses.
- Pricing sourced from public AWS Bedrock pricing pages as of writing: Claude Sonnet 4.5 is $3/M input, $15/M output tokens; Guardrails is ~$0.15 per 1,000 text units for content/denied-topic checks, ~$0.10 per 1,000 for grounding/PII checks, and blocked requests are free. Verify current rates on [aws.amazon.com/bedrock/pricing](https://aws.amazon.com/bedrock/pricing/) before relying on this for budgeting, since AWS pricing changes over time.

---

## Notes / open decisions
- Idempotency key for `submit_finance_decision`: recommend `run_id` (one decision per run, ever) — confirm before A3, since it determines first-write-wins vs. error behavior on retry, and this logic carries unchanged into Stage B.
- Repair-retry cap of 2 is a starting assumption — revisit if Bedrock output is consistently failing validation on the first pass.
- If time runs out before Stage B, Stage A alone is a legitimate submission: the spec explicitly allows CLI instead of HTTP, and "a simple local persistence mechanism is sufficient if it demonstrates restart/resume and idempotency semantics" — Stage A satisfies that literally. Document the AWS port as the planned next step in the README rather than leaving it silently undone.
