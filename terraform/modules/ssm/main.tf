# =============================================================================
# SSM Module — Secrets Management via AWS Systems Manager Parameter Store
# =============================================================================
# Stores sensitive values as SecureString parameters encrypted with a
# customer-managed KMS key (ticket 16) — not the AWS-managed alias/aws/ssm
# key. A CMK gives us: key rotation we control, a dedicated key policy, and
# an audit trail (CloudTrail) scoped to exactly this project's secrets,
# rather than sharing the account-wide default SSM key with everything else
# that happens to use SecureString.
#
# EC2 instances fetch these at boot via IAM role — no secrets ever written
# to disk (modules/autoscaling/user-data.sh fetch_ssm()).
#
# SSM Parameter Store (and KMS) are both regional — this module is
# instantiated once per enabled region (modules/region/main.tf), so each
# region gets its OWN CMK. This is intentional, not an oversight: a KMS key
# cannot be reused across regions in the way a global IAM role can. The
# matching kms:Decrypt grant lives in aws_iam_role_policy.ssm_kms_decrypt
# below, scoped to exactly this region's key ARN, attached to the single
# global IAM role via var.iam_role_name (passed down from modules/iam
# through modules/region — see wiring note there for why the grant isn't
# centralized in modules/iam itself: doing so would create a module
# dependency cycle, since modules/region already depends on modules/iam for
# instance_profile_name).
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  # Ticket 31 / decision D3: every runtime resource NAME is qualified by the
  # environment so staging and production can coexist in AWS account
  # 505307260926 (ADR 0028). Deterministic from var.environment — full token,
  # no abbreviation map (all names verified inside AWS length limits).
  # TAGS keep using var.project_name; only NAMES take the prefix.
  env_prefix = "${var.project_name}-${var.environment}"
}

# --- Customer-managed KMS key for SSM SecureString encryption ---
resource "aws_kms_key" "ssm" {
  description             = "Customer-managed key for ${var.project_name} SSM SecureString parameters (ticket 16)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Project = var.project_name
  }
}

resource "aws_kms_alias" "ssm" {
  name          = "alias/${local.env_prefix}-ssm"
  target_key_id = aws_kms_key.ssm.key_id
}

# --- kms:Decrypt grant for the EC2 instance role, scoped to exactly this key ---
# SecureString decryption at boot (user-data.sh fetch_ssm) needs kms:Decrypt
# in addition to the ssm:GetParameter grant already in modules/iam. Colocated
# here (not in modules/iam) so the Resource ARN is a direct local reference
# to aws_kms_key.ssm.arn — no cross-module output plumbing, no risk of the
# ARN drifting from the key it's meant to scope.
#
# Name MUST be qualified per-region (var.aws_region): the IAM role is
# global but this module is instantiated once per enabled region, so two
# regions would otherwise both call aws_iam_role_policy with the same
# policy name on the same role — the second PutRolePolicy silently
# overwrites the first, leaving one region's instances unable to decrypt
# their own CMK's parameters. Same class of latent multi-region trap
# already documented in modules/iam/main.tf (log group / CreateLogGroup).
resource "aws_iam_role_policy" "ssm_kms_decrypt" {
  name = "${local.env_prefix}-ssm-kms-decrypt-${var.aws_region}"
  role = var.iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.ssm.arn
      }
    ]
  })
}

# --- JWT Secret ---
resource "aws_ssm_parameter" "jwt_secret" {
  name        = "/${local.env_prefix}/jwt-secret"
  description = "JWT secret shared with Laravel backend"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.jwt_secret

  tags = {
    Project = var.project_name
  }
}

# --- JWT Secret, rotation overlap (ticket 28) ---
# Created ONLY while a rotation is in flight. Outside one the parameter is
# absent, fetch_ssm() returns "", and JWT_SECRET_PREVIOUS lands in the env-file
# empty — which is MSAB's own default, so boot behaviour is unchanged.
# ⚠️ Adding/removing this parameter does NOT restart anything: instances read
# SSM once, at boot (modules/autoscaling/user-data.sh). A rotation is
# apply + instance refresh, in that order.
resource "aws_ssm_parameter" "jwt_secret_previous" {
  count       = var.jwt_secret_previous == "" ? 0 : 1
  name        = "/${local.env_prefix}/jwt-secret-previous"
  description = "Outgoing JWT secret(s) still accepted during a rotation (comma-separated)"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.jwt_secret_previous

  tags = {
    Project = var.project_name
  }
}

# --- Laravel Internal Key ---
resource "aws_ssm_parameter" "laravel_internal_key" {
  name        = "/${local.env_prefix}/laravel-internal-key"
  description = "Shared secret key for Laravel API authentication"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.laravel_internal_key

  tags = {
    Project = var.project_name
  }
}

# --- Session Secret ---
resource "aws_ssm_parameter" "session_secret" {
  name        = "/${local.env_prefix}/session-secret"
  description = "Express session secret"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.session_secret

  tags = {
    Project = var.project_name
  }
}

# --- Cloudflare TURN API Key ---
resource "aws_ssm_parameter" "cloudflare_turn_api_key" {
  name        = "/${local.env_prefix}/cloudflare-turn-api-key"
  description = "Cloudflare Realtime TURN API bearer token"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.cloudflare_turn_api_key

  tags = {
    Project = var.project_name
  }
}

# --- realtime-09 broadcast HLS R2 keys ---
# Only created when the broadcast tier is enabled — SSM rejects empty SecureString
# values, and a disabled host's fetch_ssm gracefully returns "" for a missing param.
resource "aws_ssm_parameter" "hls_r2_access_key_id" {
  count       = var.broadcast_hls_enabled ? 1 : 0
  name        = "/${local.env_prefix}/hls-r2-access-key-id"
  description = "R2 Object Read/Write access key id for HLS publishing"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.hls_r2_access_key_id

  tags = {
    Project = var.project_name
  }
}

resource "aws_ssm_parameter" "hls_r2_secret_access_key" {
  count       = var.broadcast_hls_enabled ? 1 : 0
  name        = "/${local.env_prefix}/hls-r2-secret-access-key"
  description = "R2 Object Read/Write secret access key for HLS publishing"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.hls_r2_secret_access_key

  tags = {
    Project = var.project_name
  }
}

# --- Redis AUTH Token ---
resource "aws_ssm_parameter" "redis_auth_token" {
  name        = "/${local.env_prefix}/redis-auth-token"
  description = "Redis AUTH token"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.key_id
  value       = var.redis_auth_token

  tags = {
    Project = var.project_name
  }
}
