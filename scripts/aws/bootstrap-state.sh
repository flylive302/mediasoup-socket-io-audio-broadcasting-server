#!/bin/bash
# =============================================================================
# FlyLive Audio Server — Bootstrap Terraform State Backend
# =============================================================================
# Creates the S3 bucket for remote Terraform state and writes terraform/backend.hcl
# for the CURRENT AWS account. Run ONCE per account (staging and production).
#
# Locking uses S3 native lockfiles (terraform { backend "s3" { use_lockfile = true }})
# — no DynamoDB table is required.
#
# Usage:
#   AWS_PROFILE=flylive-staging ./scripts/aws/bootstrap-state.sh
#   AWS_PROFILE=flylive-prod    ./scripts/aws/bootstrap-state.sh
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

# Write the account-specific backend config (gitignored).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_HCL="${SCRIPT_DIR}/../../terraform/backend.hcl"
printf 'bucket = "%s"\n' "$BUCKET_NAME" > "$BACKEND_HCL"
echo "📝 Wrote ${BACKEND_HCL}"

echo ""
echo "✅ State backend ready!"
echo ""
echo "Next steps:"
echo "  cd terraform"
echo "  terraform init -reconfigure -backend-config=backend.hcl"
echo "  terraform plan -var-file=<staging|prod>.tfvars -out=tfplan"
