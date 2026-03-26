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

# --- Redis AUTH Token ---
resource "aws_ssm_parameter" "redis_auth_token" {
  name  = "/${var.project_name}/redis-auth-token"
  type  = "SecureString"
  value = var.redis_auth_token

  tags = {
    Project = var.project_name
  }
}
