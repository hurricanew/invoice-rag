# Scoped, short-lived credentials for interviewer demo access

This gives an interviewer a working Bedrock connection without setting up their own AWS account, without giving them any access beyond the two Bedrock actions this project needs, and without any long-lived secret in play — the credential expires on its own.

**Run this yourself.** The script prints a secret credential to your terminal — copy that block and send it to the client however you'd send any short-lived secret. Nothing in this flow should be pasted into a chat session, committed to the repo, or generated/handled by an assistant on your behalf.

## One-time setup

Copy the example policy and fill in your real values:

```bash
cp iam/interviewer-bedrock-policy.example.json iam/interviewer-bedrock-policy.json
```

Edit `iam/interviewer-bedrock-policy.json` — replace `<region>`, `<account-id>`, `<model-id>`, `<guardrail-id>` with your real values (this file is gitignored, it will not be committed).

## Mint and send credentials

```bash
cd iam
./mint-demo-credentials.sh          # defaults to 1 hour
./mint-demo-credentials.sh 7200     # or pass a custom duration in seconds (max 129600 = 36h)
```

This does everything in one step:
1. Creates (or reuses) a dedicated IAM user, `invoice-rag-interviewer-demo`, with an inline policy scoped to exactly `bedrock:InvokeModel` on your one model ARN and `bedrock:ApplyGuardrail` on your one guardrail ARN.
2. Creates a temporary access key on that user, uses it once to mint an STS session token, then immediately deletes the access key — only the session token (not the underlying key) is meant to be shared.
3. Prints a ready-to-send block:

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
AWS_REGION=us-east-1
# expires: 2026-09-10T15:30:00Z
```

Copy that block and send it to the client. Tell them to paste those four lines into their `.env` and **delete/leave unset the `AWS_PROFILE` line** — if `AWS_PROFILE` is present at all, the AWS SDK's credential chain may prefer a named profile over these environment variables, which would defeat the point. `src/lib/bedrockDecision.ts` constructs its Bedrock client without specifying a profile, so with `AWS_PROFILE` absent it correctly picks up these four variables instead.

## Cleanup

The session token expires on its own — no action needed. If you want to remove the IAM user entirely (e.g. you're done reusing it for future demos):

```bash
aws iam delete-user-policy --user-name invoice-rag-interviewer-demo --policy-name BedrockInvokeAndGuardrailOnly --profile rag-demo-2
aws iam delete-user --user-name invoice-rag-interviewer-demo --profile rag-demo-2
```

## What this grants, precisely

Nothing beyond invoking one specific Bedrock model and applying one specific guardrail — no ability to create, modify, list, or delete any AWS resource, no console access, no access to any other service. The only cost exposure is Bedrock's per-token pricing for whatever the interviewer actually runs (a handful of cents for the 5 test cases).
