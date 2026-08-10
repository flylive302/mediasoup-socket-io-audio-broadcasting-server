#!/bin/bash
# =============================================================================
# FlyLive Audio Server — Bootstrap Terraform State Backend
# =============================================================================
# Creates the S3 bucket for remote Terraform state and writes
# terraform/backend-staging.hcl + terraform/backend-production.hcl for the
# CURRENT AWS account. Run ONCE per account.
#
# Layout (ADR 0028 — single account, key-per-environment):
#   one bucket, env/staging/terraform.tfstate + env/production/terraform.tfstate.
#   Staging and production NEVER share a state file.
#
# Locking uses S3 native lockfiles (terraform { backend "s3" { use_lockfile = true }})
# — no DynamoDB table is required.
#
# Usage:
#   AWS_PROFILE=flylive-prod ./scripts/aws/bootstrap-state.sh
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"

# Account ID is derived from the active credentials — never hardcoded, so the same
# script works in any account.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="flylive-audio-tfstate-${ACCOUNT_ID}"

echo "🔎 Account: ${ACCOUNT_ID}  Region: ${REGION}"
echo "🪣 Creating S3 bucket: $BUCKET_NAME"
aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION" \
  2>/dev/null || echo "   Bucket already exists"

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
  }'

# Block public access
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "🔒 Created S3 bucket with versioning + encryption + public access blocked"

# Write the account-specific per-environment backend configs (gitignored).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for ENV in staging production; do
  BACKEND_HCL="${SCRIPT_DIR}/../../terraform/backend-${ENV}.hcl"
  printf 'bucket = "%s"\nkey    = "env/%s/terraform.tfstate"\n' "$BUCKET_NAME" "$ENV" > "$BACKEND_HCL"
  echo "📝 Wrote ${BACKEND_HCL}"
done

# A leftover single-file backend.hcl predates the key-per-environment layout and
# may point at a closed account — refuse to leave it lying around silently.
LEGACY="${SCRIPT_DIR}/../../terraform/backend.hcl"
if [ -f "$LEGACY" ]; then
  mv "$LEGACY" "${LEGACY}.pre-adr-0028.bak"
  echo "⚠️  Moved legacy backend.hcl → backend.hcl.pre-adr-0028.bak (do not init with it)"
fi

echo ""
echo "✅ State backend ready!"
echo ""
echo "Next steps:"
echo "  cd terraform"
echo "  terraform init -reconfigure -backend-config=backend-production.hcl"
echo "  terraform plan -var-file=prod.tfvars -out=tfplan"
echo "  # staging: re-init with -backend-config=backend-staging.hcl and staging.tfvars"
