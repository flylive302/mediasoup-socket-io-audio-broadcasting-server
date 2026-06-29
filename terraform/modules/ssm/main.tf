# =============================================================================
# SSM Module — Secrets Management via AWS Systems Manager Parameter Store
# =============================================================================
# Stores sensitive values as SecureString parameters encrypted with AWS-managed KMS.
# EC2 instances fetch these at boot via IAM role — no secrets ever written to disk.
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# --- JWT Secret ---
resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project_name}/jwt-secret"
  type  = "SecureString"
  value = var.jwt_secret

  tags = {
    Project = var.project_name
  }
}

# --- Laravel Internal Key ---
resource "aws_ssm_parameter" "laravel_internal_key" {
  name  = "/${var.project_name}/laravel-internal-key"
  type  = "SecureString"
  value = var.laravel_internal_key

  tags = {
    Project = var.project_name
  }
}

# --- Session Secret ---
resource "aws_ssm_parameter" "session_secret" {
  name  = "/${var.project_name}/session-secret"
  type  = "SecureString"
  value = var.session_secret

  tags = {
    Project = var.project_name
  }
}

# --- Cloudflare TURN API Key ---
resource "aws_ssm_parameter" "cloudflare_turn_api_key" {
  name  = "/${var.project_name}/cloudflare-turn-api-key"
  type  = "SecureString"
  value = var.cloudflare_turn_api_key

  tags = {
    Project = var.project_name
  }
}

# --- realtime-09 broadcast HLS R2 keys ---
# Only created when the broadcast tier is enabled — SSM rejects empty SecureString
# values, and a disabled host's fetch_ssm gracefully returns "" for a missing param.
resource "aws_ssm_parameter" "hls_r2_access_key_id" {
  count = var.broadcast_hls_enabled ? 1 : 0
  name  = "/${var.project_name}/hls-r2-access-key-id"
  type  = "SecureString"
  value = var.hls_r2_access_key_id

  tags = {
    Project = var.project_name
  }
}

resource "aws_ssm_parameter" "hls_r2_secret_access_key" {
  count = var.broadcast_hls_enabled ? 1 : 0
  name  = "/${var.project_name}/hls-r2-secret-access-key"
  type  = "SecureString"
  value = var.hls_r2_secret_access_key

  tags = {
    Project = var.project_name
  }
}

# --- Redis AUTH Token ---
resource "aws_ssm_parameter" "redis_auth_token" {
  name  = "/${var.project_name}/redis-auth-token"
  type  = "SecureString"
  value = var.redis_auth_token

  tags = {
    Project = var.project_name
  }
}
