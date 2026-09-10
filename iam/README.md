# Scoped, short-lived credentials for interviewer demo access

This gives an interviewer a working Bedrock connection without setting up their own AWS account, without giving them any access beyond the two Bedrock actions this project needs, and without any long-lived secret in play — the credential expires on its own.

**Run these commands yourself.** Nothing here should be pasted into a chat session, committed to the repo, or handled by an assistant — the actual key/secret/session-token values are secrets the moment they're generated.

## 1. Create a dedicated IAM user (one-time)

No console password, no long-lived access key issued directly on this user — it exists only so you can generate temporary tokens scoped to it.

```bash
aws iam create-user --user-name invoice-rag-interviewer-demo --profile rag-demo-2

aws iam put-user-policy \
  --user-name invoice-rag-interviewer-demo \
  --policy-name BedrockInvokeAndGuardrailOnly \
  --policy-document file://interviewer-bedrock-policy.json \
  --profile rag-demo-2
```

`interviewer-bedrock-policy.json` (gitignored — it embeds your real account ID and guardrail ID) scopes this user to exactly `bedrock:InvokeModel` on your specific model ARN and `bedrock:ApplyGuardrail` on your specific guardrail ARN. See `interviewer-bedrock-policy.example.json` for the shape with placeholders.

## 2. Generate a short-lived access key, then immediately mint a session token from it

IAM users can't call `sts:GetSessionToken` without an underlying access key, so this needs two steps — but the underlying access key never needs to be shared; only the temporary session token is.

```bash
# Creates a long-lived key pair on the dedicated user — used only to mint the
# temporary token below, then deleted immediately after (step 4).
aws iam create-access-key --user-name invoice-rag-interviewer-demo --profile rag-demo-2
```

Note the `AccessKeyId` and `SecretAccessKey` from the output, then use them (not your own `rag-demo-2` credentials) to mint a short-lived session token:

```bash
AWS_ACCESS_KEY_ID=<from-previous-step> \
AWS_SECRET_ACCESS_KEY=<from-previous-step> \
aws sts get-session-token --duration-seconds 3600
```

`--duration-seconds 3600` = 1 hour. Minimum is 900 (15 min), maximum for an IAM user's own session token is 129600 (36 hours) — pick whatever matches how long the demo/interview will actually take.

## 3. Give the interviewer the session-token output only

The `get-session-token` output has three fields: `AccessKeyId`, `SecretAccessKey`, `SessionToken`. Send these three values to the interviewer (however you'd share any short-lived secret — not via a public channel) and have them set:

```bash
export AWS_ACCESS_KEY_ID=<...>
export AWS_SECRET_ACCESS_KEY=<...>
export AWS_SESSION_TOKEN=<...>
export AWS_REGION=us-east-1
```

In the project's `.env`, they must **leave `AWS_PROFILE` unset entirely** (delete the line, don't just set it blank) — if `AWS_PROFILE` is present in the environment at all, the AWS SDK's credential chain may prefer the named profile over the `AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN` variables above, which would defeat the point. `src/lib/bedrockDecision.ts` constructs `BedrockRuntimeClient({ region })` without specifying credentials or a profile, so with `AWS_PROFILE` absent it correctly falls through to the environment-variable credentials.

## 4. Clean up after the demo

```bash
# Delete the underlying access key (step 2) — the session token it minted
# keeps working until it naturally expires regardless of this.
aws iam list-access-keys --user-name invoice-rag-interviewer-demo --profile rag-demo-2
aws iam delete-access-key --user-name invoice-rag-interviewer-demo --access-key-id <id> --profile rag-demo-2

# Remove the user entirely once you're done reusing it for future demos
aws iam delete-user-policy --user-name invoice-rag-interviewer-demo --policy-name BedrockInvokeAndGuardrailOnly --profile rag-demo-2
aws iam delete-user --user-name invoice-rag-interviewer-demo --profile rag-demo-2
```

The session token itself cannot be revoked early (AWS doesn't support revoking STS tokens directly) — it simply expires at the `--duration-seconds` you chose in step 2. Choose a duration no longer than you actually need.

## Cost note

This grants no ability to create/modify/delete any resource — only to invoke the model and apply the guardrail. The only cost exposure is Bedrock per-token pricing for whatever the interviewer actually runs (a handful of cents for the 5 test cases — see the cost estimate in [tasks.md](../tasks.md)).
