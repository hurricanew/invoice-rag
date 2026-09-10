#!/usr/bin/env bash
# Run this yourself. It creates (or reuses) a dedicated IAM user scoped to
# only bedrock:InvokeModel on one model ARN and bedrock:ApplyGuardrail on one
# guardrail ARN, then mints a short-lived STS session token and prints the
# three values to copy into your message to the client. Nothing here is
# executed by an assistant — you run it, you see the output, you send it.
#
# Usage: ./mint-demo-credentials.sh [duration_seconds]
#   duration_seconds defaults to 3600 (1 hour). Max for an IAM user's own
#   session token is 129600 (36 hours). Minimum is 900 (15 minutes).

set -euo pipefail

PROFILE="${AWS_PROFILE:-rag-demo-2}"
USER_NAME="invoice-rag-interviewer-demo"
POLICY_NAME="BedrockInvokeAndGuardrailOnly"
POLICY_FILE="$(dirname "$0")/interviewer-bedrock-policy.json"
DURATION="${1:-3600}"

if [ ! -f "$POLICY_FILE" ]; then
  echo "Missing $POLICY_FILE — copy interviewer-bedrock-policy.example.json," >&2
  echo "fill in your real region/account-id/model-id/guardrail-id, save it as" >&2
  echo "interviewer-bedrock-policy.json (gitignored), then rerun this script." >&2
  exit 1
fi

echo "== Using AWS profile: $PROFILE ==" >&2

# Idempotent: create the user only if it doesn't already exist.
if ! aws iam get-user --user-name "$USER_NAME" --profile "$PROFILE" >/dev/null 2>&1; then
  echo "Creating IAM user $USER_NAME..." >&2
  aws iam create-user --user-name "$USER_NAME" --profile "$PROFILE" >/dev/null
fi

echo "Attaching scoped inline policy..." >&2
aws iam put-user-policy \
  --user-name "$USER_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://$POLICY_FILE" \
  --profile "$PROFILE"

# Clean up any pre-existing access keys on this user first — an IAM user can
# have at most 2, and this script should be safely re-runnable.
EXISTING_KEYS=$(aws iam list-access-keys --user-name "$USER_NAME" --profile "$PROFILE" --query "AccessKeyMetadata[].AccessKeyId" --output text)
for KEY_ID in $EXISTING_KEYS; do
  echo "Deleting pre-existing access key $KEY_ID..." >&2
  aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$KEY_ID" --profile "$PROFILE"
done

echo "Creating a fresh access key (used only to mint the session token below)..." >&2
KEY_JSON=$(aws iam create-access-key --user-name "$USER_NAME" --profile "$PROFILE")
AKID=$(echo "$KEY_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
SECRET=$(echo "$KEY_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")

# IAM access keys can take a few seconds to become usable for signing.
sleep 8

echo "Minting a $DURATION-second session token..." >&2
# AWS_PROFILE must be UNSET here, not set to an empty string — the AWS CLI
# treats AWS_PROFILE="" as "use the profile literally named ''", which
# fails with "The config profile () could not be found". `env -u` removes
# the variable entirely from the subprocess's environment instead.
TOKEN_JSON=$(env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$AKID" AWS_SECRET_ACCESS_KEY="$SECRET" \
  aws sts get-session-token --duration-seconds "$DURATION")

echo "Deleting the underlying access key (the session token above keeps working on its own)..." >&2
aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$AKID" --profile "$PROFILE"

echo "" >&2
echo "== Send the client exactly this block (expires in $((DURATION / 60)) minutes) ==" >&2
echo "" >&2
echo "$TOKEN_JSON" | python3 -c "
import json, sys
c = json.load(sys.stdin)['Credentials']
print(f'AWS_ACCESS_KEY_ID={c[\"AccessKeyId\"]}')
print(f'AWS_SECRET_ACCESS_KEY={c[\"SecretAccessKey\"]}')
print(f'AWS_SESSION_TOKEN={c[\"SessionToken\"]}')
print(f'AWS_REGION=us-east-1')
print(f'# expires: {c[\"Expiration\"]}')
"
