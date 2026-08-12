# =============================================================================
# SSM module — customer-managed KMS key for SecureString parameters (ticket 16)
# =============================================================================
# Module-scoped run against ./modules/ssm directly (not the root config), with
# a mocked aws provider — offline, no API calls, no cost, no credentials.
# Standalone file per the established pattern (see tests/log_retention.tftest.hcl
# and tests/ssl_validation.tftest.hcl) — a module-scoped `module { source = ... }`
# block re-types the mock providers for the whole file it lives in.
#
# aws_kms_key.ssm's key_id/arn are Computed (assigned by AWS at create time),
# so they're unknown under `command = plan` even with a mocked provider —
# mock_resource "aws_kms_key" { defaults = { key_id = ... } } supplies a
# concrete value so aws_ssm_parameter.*.key_id (which references it) can also
# resolve and be asserted on at plan time.
# =============================================================================

mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = {
      key_id = "11111111-2222-3333-4444-555555555555"
      arn    = "arn:aws:kms:ap-south-1:111111111111:key/11111111-2222-3333-4444-555555555555"
    }
  }
}

variables {
  project_name            = "flylive-audio"
  environment             = "production"
  iam_role_name           = "flylive-audio-production-ec2-role"
  aws_region              = "ap-south-1"
  jwt_secret              = "test-jwt-secret"
  laravel_internal_key    = "test-laravel-internal-key"
  session_secret          = "test-session-secret"
  cloudflare_turn_api_key = "test-cf-turn-api-key"
  redis_auth_token        = "test-redis-auth-token"
}

# -----------------------------------------------------------------------------
# modules/ssm/main.tf `aws_kms_key.ssm`: customer-managed (not the AWS-managed
# alias/aws/ssm key), rotation enabled, 30-day deletion window, and an alias
# following the `alias/<project_name>-ssm` convention.
# -----------------------------------------------------------------------------
run "kms_key_is_customer_managed_with_rotation_and_deletion_window" {
  command = plan

  module {
    source = "./modules/ssm"
  }

  assert {
    condition     = aws_kms_key.ssm.enable_key_rotation == true
    error_message = "SSM CMK must have automatic key rotation enabled"
  }

  assert {
    condition     = aws_kms_key.ssm.deletion_window_in_days == 30
    error_message = "SSM CMK must have a 30-day deletion window"
  }

  assert {
    condition     = aws_kms_alias.ssm.name == "alias/flylive-audio-production-ssm"
    error_message = "SSM CMK alias must follow the alias/<project_name>-ssm convention"
  }
}

# -----------------------------------------------------------------------------
# Every SecureString parameter must be encrypted with the customer-managed
# key (not left on the AWS-managed default), and the parameter type itself
# must stay SecureString.
# -----------------------------------------------------------------------------
# command = apply (not plan): aws_kms_key.ssm.key_id is Computed, and even
# under mock_resource defaults it stays unknown at plan time for values
# referenced through another resource's attribute (only the KMS key's own
# attributes resolve at plan; aws_ssm_parameter.*.key_id, which references
# it, does not). Provider is still fully mocked — no real API calls, no
# credentials, no cost — "apply" here only means "let the mocked graph
# resolve," not "touch real infrastructure."
run "securestring_parameters_use_the_customer_managed_key" {
  command = apply

  module {
    source = "./modules/ssm"
  }

  assert {
    condition     = aws_ssm_parameter.jwt_secret.key_id == aws_kms_key.ssm.key_id
    error_message = "jwt_secret parameter must be encrypted with the customer-managed key"
  }

  assert {
    condition     = aws_ssm_parameter.jwt_secret.type == "SecureString"
    error_message = "jwt_secret parameter must remain a SecureString"
  }

  assert {
    condition     = aws_ssm_parameter.laravel_internal_key.key_id == aws_kms_key.ssm.key_id
    error_message = "laravel_internal_key parameter must be encrypted with the customer-managed key"
  }

  assert {
    condition     = aws_ssm_parameter.session_secret.key_id == aws_kms_key.ssm.key_id
    error_message = "session_secret parameter must be encrypted with the customer-managed key"
  }

  assert {
    condition     = aws_ssm_parameter.cloudflare_turn_api_key.key_id == aws_kms_key.ssm.key_id
    error_message = "cloudflare_turn_api_key parameter must be encrypted with the customer-managed key"
  }

  assert {
    condition     = aws_ssm_parameter.redis_auth_token.key_id == aws_kms_key.ssm.key_id
    error_message = "redis_auth_token parameter must be encrypted with the customer-managed key"
  }
}

# -----------------------------------------------------------------------------
# HLS R2 parameters (count-gated on var.broadcast_hls_enabled) must also use
# the customer-managed key when the broadcast tier is on.
# -----------------------------------------------------------------------------
# command = apply for the same reason as the run above — key_id equality
# referenced through another resource's attribute is unknown at plan time.
run "hls_r2_parameters_use_the_customer_managed_key_when_enabled" {
  command = apply

  module {
    source = "./modules/ssm"
  }

  variables {
    broadcast_hls_enabled    = true
    hls_r2_access_key_id     = "test-r2-access-key-id"
    hls_r2_secret_access_key = "test-r2-secret-access-key"
  }

  assert {
    condition     = aws_ssm_parameter.hls_r2_access_key_id[0].key_id == aws_kms_key.ssm.key_id
    error_message = "hls_r2_access_key_id parameter must be encrypted with the customer-managed key"
  }

  assert {
    condition     = aws_ssm_parameter.hls_r2_secret_access_key[0].key_id == aws_kms_key.ssm.key_id
    error_message = "hls_r2_secret_access_key parameter must be encrypted with the customer-managed key"
  }
}

# -----------------------------------------------------------------------------
# kms:Decrypt is granted to the shared EC2 role, scoped to exactly this
# region's CMK ARN (not a wildcard), and the policy name is region-qualified
# so two enabled regions never collide on the same role (see comment above
# aws_iam_role_policy.ssm_kms_decrypt in modules/ssm/main.tf).
# -----------------------------------------------------------------------------
run "kms_decrypt_grant_is_scoped_to_this_key_and_region_qualified" {
  command = plan

  module {
    source = "./modules/ssm"
  }

  assert {
    condition     = aws_iam_role_policy.ssm_kms_decrypt.role == "flylive-audio-production-ec2-role"
    error_message = "kms:Decrypt grant must attach to the shared EC2 instance role"
  }

  assert {
    condition     = aws_iam_role_policy.ssm_kms_decrypt.name == "flylive-audio-production-ssm-kms-decrypt-ap-south-1"
    error_message = "kms:Decrypt policy name must be region-qualified to avoid colliding across enabled regions"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.ssm_kms_decrypt.policy, "kms:Decrypt")
    error_message = "Policy must grant kms:Decrypt"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.ssm_kms_decrypt.policy, "\"Resource\":\"*\"")
    error_message = "kms:Decrypt must be scoped to the specific key ARN, not a wildcard"
  }
}
