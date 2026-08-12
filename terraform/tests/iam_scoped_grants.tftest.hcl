# =============================================================================
# IAM module — ticket 04 (2026-08-12 pre-apply review, finding F5): the two
# over-wide IAM grants must actually enforce what their comments claim.
# =============================================================================
# ROOT-level runs against the real config (not module-scoped) — a
# `module { source = ... }` block in a run re-types the test suite's
# unaliased "cloudflare" mock_provider for the whole `terraform test`
# invocation and breaks every other file that expects it (modules/iam never
# references cloudflare, so nothing anchors the retype back to the root's
# cloudflare/cloudflare source) — see the trap documented in
# tests/redis_store_split.tftest.hcl, and same reasoning as
# tests/plan_assertions.tftest.hcl. Same provider-mock header + variables as
# those two files. Nested-module resources (aws_iam_role_policy.*,
# aws_iam_policy.*) aren't addressable from a root-level run's asserts, so
# this reads them through the ecr_pull_policy / github_actions_boundary_policy
# / github_actions_asg_refresh_policy test-seam outputs added to
# modules/iam/outputs.tf for exactly this purpose.
# =============================================================================

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "aws" {
  alias = "mumbai"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "aws" {
  alias = "frankfurt"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "aws" {
  alias = "singapore"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "cloudflare" {}

variables {
  project_name         = "flylive-audio"
  environment          = "production"
  audio_domain         = "audio.flyliveapp.com"
  cloudflare_zone_id   = "mock-zone-id"
  caa_records_override = []
  ssh_public_key_path  = "./tests/fixtures/id_ed25519.pub"

  # Required, no-default sensitive vars — dummies, never applied (same set as
  # plan_assertions.tftest.hcl / tests/redis_store_split.tftest.hcl).
  redis_auth_token     = "test-redis-auth-token-0123456789ab"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret           = "test-jwt-secret-0123456789abcdef"
  cloudflare_api_token = "test-cloudflare-api-token-0123456789ab"

  # Required, no-default (ticket 14: image_tag has no default and rejects "latest").
  image_tag = "sha-deadbeef"
}

# -----------------------------------------------------------------------------
# modules/iam/main.tf `aws_iam_role_policy.ecr_pull`: pull actions
# (BatchGetImage / GetDownloadUrlForLayer / BatchCheckLayerAvailability) must
# be scoped to the MSAB repo ARN, not account-wide. GetAuthorizationToken
# stays "*" (the action does not support resource scoping). The scoped ARN
# widens only the region segment to "*" (local.ecr_pull_resource) so pulls
# from every enabled region's replicated, same-named, same-account repo
# still match — not just the home region's.
# -----------------------------------------------------------------------------
# `command = plan`, like every other file in this suite. `apply` against the
# mocked providers fails unrelated resources (CloudWatch alarms reject the mock's
# non-ARN strings), and it isn't needed: modules/ecr's `pull_resource_arn` is
# built from the CONFIGURED repo name + the mocked caller identity, so the whole
# rendered policy is plan-known.
run "ecr_pull_is_scoped_to_the_msab_repository_across_regions" {
  command = plan

  assert {
    condition     = strcontains(module.iam.ecr_pull_policy, "\"Resource\":\"arn:aws:ecr:*:111111111111:repository/flylive-audio/msab\"")
    error_message = "ecr_pull policy must scope BatchGetImage/GetDownloadUrlForLayer/BatchCheckLayerAvailability to a region-wildcarded MSAB repo ARN, not \"*\""
  }

  assert {
    condition     = !strcontains(module.iam.ecr_pull_policy, "\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\",\"ecr:BatchCheckLayerAvailability\"],\"Resource\":\"*\"")
    error_message = "ecr_pull policy must not leave BatchGetImage/GetDownloadUrlForLayer/BatchCheckLayerAvailability on Resource \"*\""
  }

  assert {
    condition     = strcontains(module.iam.ecr_pull_policy, "\"ecr:GetAuthorizationToken\"")
    error_message = "ecr_pull policy must still grant ecr:GetAuthorizationToken"
  }
}

# -----------------------------------------------------------------------------
# modules/iam/main.tf `aws_iam_policy.github_actions_boundary` and
# `aws_iam_role_policy.github_actions_asg_refresh`: the SSM SendCommand grant
# must no longer use StringEqualsIfExists (true when the tag is absent, so it
# covered every untagged instance in the account too) — StringEquals denies
# by default when the tag is missing. Document invocation (SSM documents
# carry no instance tags) must remain a separate, ungated statement so the
# tag condition never applies to it and Session Manager doesn't break.
# -----------------------------------------------------------------------------
run "sendcommand_denies_untagged_instances_and_keeps_document_invocation_ungated" {
  command = plan

  # [1] instance targeting: StringEquals, never StringEqualsIfExists — IfExists
  # is TRUE when the tag is absent, which is exactly the ticket-04 defect.
  assert {
    condition = alltrue([
      module.iam.ssm_send_command_statements[1].Resource == ["arn:aws:ec2:*:*:instance/*"],
      keys(module.iam.ssm_send_command_statements[1].Condition) == ["StringEquals"],
      module.iam.ssm_send_command_statements[1].Condition.StringEquals["ssm:resourceTag/Project"] == "flylive-audio",
    ])
    error_message = "Instance-targeting SendCommand must be gated by StringEquals on this project's tag — StringEqualsIfExists evaluates true for UNTAGGED instances, granting the whole account."
  }

  # [0] document invocation stays a SEPARATE, ungated statement. Folding it back
  # into [1] would apply the tag condition to an SSM document ARN, which carries
  # no instance tags, and silently break Session Manager.
  assert {
    condition = alltrue([
      module.iam.ssm_send_command_statements[0].Resource == ["arn:aws:ssm:*::document/AWS-RunShellScript"],
      !can(module.iam.ssm_send_command_statements[0].Condition),
    ])
    error_message = "Document invocation must stay its own statement with NO tag condition — SSM documents carry no instance tags, so gating it denies Session Manager."
  }

  # Neither statement may quietly widen back to a bare wildcard.
  assert {
    condition = alltrue([
      !contains(module.iam.ssm_send_command_statements[0].Resource, "*"),
      !contains(module.iam.ssm_send_command_statements[1].Resource, "*"),
      length(module.iam.ssm_send_command_statements) == 2,
    ])
    error_message = "SendCommand must stay exactly two narrowly-scoped statements."
  }
}
