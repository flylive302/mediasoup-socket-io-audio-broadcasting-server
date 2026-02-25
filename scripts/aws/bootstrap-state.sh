#!/bin/bash
# =============================================================================
# FlyLive Audio Server — Bootstrap Terraform State Backend
# =============================================================================
# Creates S3 bucket + DynamoDB table for remote Terraform state.
# Run this ONCE before enabling the backend block in terraform/main.tf.
# =============================================================================

set -euo pipefail

REGION="ap-south-1"
BUCKET_NAME="flylive-audio-terraform-state"
DYNAMO_TABLE="flylive-audio-terraform-locks"

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

echo "📋 Creating DynamoDB table: $DYNAMO_TABLE"
aws dynamodb create-table \
  --table-name "$DYNAMO_TABLE" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION" \
  2>/dev/null || echo "   Table already exists"

echo ""
echo "✅ State backend ready!"
echo ""
echo "Next steps:"
echo "  1. Uncomment the backend \"s3\" block in terraform/main.tf"
echo "  2. Run: cd terraform && terraform init -migrate-state"
echo "  3. Confirm migration when prompted"
