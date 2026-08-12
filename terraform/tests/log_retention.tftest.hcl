# =============================================================================
# IAM module — CloudWatch log group retention (aws-platform-build ticket 15:
# "Log group and retention as real resources")
# =============================================================================
# Module-scoped run against ./modules/iam directly (not the root config) with
# a mocked aws provider — offline, no API calls, no cost, no credentials.
#
# This is a standalone file (not appended to plan_assertions.tftest.hcl)
# because a module-scoped `module { source = "./modules/iam" }` block
# re-types the mock providers for the WHOLE test suite file it lives in —
# same reasoning as tests/ssl_validation.tftest.hcl being its own file.
#
# aws_cloudwatch_log_group.msab lives inside modules/iam/main.tf and is not
# reachable from a root-level `run` block's asserts (nested-module resources
# aren't exposed there), so this has to run scoped to the module itself.
# =============================================================================

mock_provider "aws" {}

variables {
  project_name          = "flylive-audio"
  ecr_repository_arn    = "arn:aws:ecr:ap-south-1:111111111111:repository/flylive-audio"
  ecr_pull_resource_arn = "arn:aws:ecr:*:111111111111:repository/flylive-audio"
}

# -----------------------------------------------------------------------------
# modules/iam/main.tf `aws_cloudwatch_log_group.msab`: retention must be set
# explicitly to the intended value (not left at the provider default of
# "never expire") and the name must match the literal the CloudWatch Agent
# writes to in modules/autoscaling/user-data.sh:264-292
# ("/flylive-audio/msab" when project_name = "flylive-audio").
# -----------------------------------------------------------------------------
run "log_group_has_intended_retention_and_name" {
  command = plan

  module {
    source = "./modules/iam"
  }

  assert {
    condition     = aws_cloudwatch_log_group.msab.retention_in_days == 30
    error_message = "MSAB CloudWatch log group must retain logs for 30 days (operational debugging window, bounded cost)"
  }

  assert {
    condition     = aws_cloudwatch_log_group.msab.name == "/flylive-audio/msab"
    error_message = "Log group name must match the literal log_group_name the CloudWatch Agent writes to in user-data.sh (\"/flylive-audio/msab\")"
  }
}

# -----------------------------------------------------------------------------
# modules/iam/main.tf `aws_iam_role_policy.cloudwatch_logs`: the logs ARN
# must be interpolated from var.project_name (matching the log group's own
# naming), and logs:CreateLogGroup must NOT be granted now that Terraform
# owns the group's lifecycle — the agent only creates a stream inside it.
# -----------------------------------------------------------------------------
run "cloudwatch_logs_policy_matches_group_and_drops_create_log_group" {
  command = plan

  module {
    source = "./modules/iam"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.cloudwatch_logs.policy, "arn:aws:logs:*:*:log-group:/flylive-audio/*")
    error_message = "cloudwatch_logs policy resource ARN must be scoped to the same project_name-derived path as the log group"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.cloudwatch_logs.policy, "logs:CreateLogGroup")
    error_message = "logs:CreateLogGroup should be dropped now that aws_cloudwatch_log_group.msab is Terraform-managed"
  }
}

# -----------------------------------------------------------------------------
# Ticket 12 — OIDC deploy identity. The deploy role's trust is pinned to this
# repo's gated GitHub environment (local.github_oidc_sub is the plan-known
# copy of the trust policy's sub condition — the rendered policy JSON embeds
# the computed OIDC provider ARN and is unknown at plan time), and no
# aws_iam_user / aws_iam_access_key exists in the module any more (enforced
# structurally: terraform validate fails if anything still references them;
# this run pins the role-based replacement's shape).
# -----------------------------------------------------------------------------
run "deploy_identity_is_oidc_pinned_to_repo_environment" {
  command = plan

  module {
    source = "./modules/iam"
  }

  assert {
    condition     = local.github_oidc_sub == "repo:flylive302/mediasoup-socket-io-audio-broadcasting-server:environment:aws-production"
    error_message = "Deploy role trust must be pinned to this repo's aws-production GitHub environment (defaults changed?)"
  }

  assert {
    condition     = aws_iam_role.github_actions.name == "flylive-audio-github-actions"
    error_message = "OIDC deploy role must replace the old IAM user under the same name"
  }
}
