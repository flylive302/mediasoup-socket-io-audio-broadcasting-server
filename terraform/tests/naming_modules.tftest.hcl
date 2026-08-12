# =============================================================================
# Resource naming, PER-MODULE shape — exact names, AWS length limits, and the
# D2 shared set that must NOT be qualified
# (aws-production ticket 31, executes decision D3)
# =============================================================================
# Sibling of tests/naming.tftest.hcl, which owns the root-scoped
# staging-vs-production disjointness proof. The split is not cosmetic: a
# module-scoped `module {}` block re-types the mock providers for the WHOLE
# file it lives in, so these runs cannot share a file with the `cloudflare`
# mock the root-scoped plan needs — the same reason
# tests/log_retention.tftest.hcl and tests/ssl_validation.tftest.hcl stand
# alone.
#
# WHAT THE SHARED SET IS (decision D2)
#
#   - the ECR repository "flylive-audio/msab" and its lifecycle policy
#   - the GitHub OIDC identity provider (one per account per URL)
#
# Both are ALREADY APPLIED and shared by every environment. A rename forces a
# replace, which destroys the image warehouse both environments boot from and
# would put a destroy into ticket 06's 76 create / 0 change / 0 destroy plan.
# modules/ecr never receives var.environment at all (see the comment on the
# module "ecr" block in main.tf) — the absence of the argument is the
# structural guarantee; the runs at the bottom of this file are the
# behavioural one.
#
# HOW TO MUTATION-CHECK THIS FILE (do this if you change it)
#
#   1. Revert one name in a module to "$${var.project_name}-..." → the
#      matching run must FAIL.
#   2. Give modules/ecr an `environment` variable and use it in the repository
#      name → the two shared-set runs must FAIL.
# =============================================================================

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

# Superset fixture: each module-scoped run consumes only the variables its own
# module declares, so this block is the union of every required (no-default)
# input across loadbalancer / redis / iam / ssm / ecr. Values are dummies —
# these runs are offline plans against a mock provider and never applied.
variables {
  project_name = "flylive-audio"
  environment  = "production"

  # modules/loadbalancer
  vpc_id            = "vpc-0mock000000000000"
  public_subnet_ids = ["subnet-0mockpublic0000a", "subnet-0mockpublic0000b"]
  app_port          = 3030

  # modules/redis
  redis_node_type         = "cache.t4g.micro"
  private_subnet_ids      = ["subnet-0mockprivate000a", "subnet-0mockprivate000b"]
  redis_security_group_id = "sg-0mock000000000000"

  # modules/ssm (+ redis_auth_token, shared)
  iam_role_name           = "flylive-audio-production-ec2-role"
  aws_region              = "ap-south-1"
  redis_auth_token        = "test-redis-auth-token-0123456789ab"
  laravel_internal_key    = "test-internal-key-0123456789abcdef"
  jwt_secret              = "test-jwt-secret-0123456789abcdef"
  session_secret          = "test-session-secret-0123456789ab"
  cloudflare_turn_api_key = "test-cloudflare-turn-api-key-0123"

  # modules/iam — the ECR ARNs stay UNQUALIFIED: the repository is the shared
  # set (decision D2) and its name never takes an environment token.
  ecr_repository_arn    = "arn:aws:ecr:ap-south-1:111111111111:repository/flylive-audio/msab"
  ecr_pull_resource_arn = "arn:aws:ecr:*:111111111111:repository/flylive-audio/msab"

  # modules/ecr
  replication_destination_regions = []
}

# -----------------------------------------------------------------------------
# LENGTH LIMITS (ticket 31 Trap 1). The target group name is the tightest name
# in the stack: "flylive-audio-production-app-tg" is 31 of the 32 characters
# AWS allows. If a future rename busts this, it fails HERE at plan time rather
# than at ticket 06's apply against live AWS.
# -----------------------------------------------------------------------------
run "loadbalancer_names_are_qualified_and_fit_aws_limits" {
  command = plan

  module {
    source = "./modules/loadbalancer"
  }

  assert {
    condition     = aws_lb_target_group.app.name == "flylive-audio-production-app-tg"
    error_message = "Target group must be named flylive-audio-production-app-tg (ticket 31 / D3)"
  }

  assert {
    condition     = length(aws_lb_target_group.app.name) <= 32
    error_message = "Target group names are capped at 32 characters by AWS. Switch this class to a short environment token (production->prod, staging->stg) rather than truncating by hand — see ticket 31's naming-pattern note."
  }

  assert {
    condition     = aws_lb.main.name == "flylive-audio-production-nlb"
    error_message = "NLB must be named flylive-audio-production-nlb (ticket 31 / D3)"
  }

  assert {
    condition     = length(aws_lb.main.name) <= 32
    error_message = "Network Load Balancer names are capped at 32 characters by AWS."
  }
}

# -----------------------------------------------------------------------------
# ElastiCache replication group ids are capped at 40 characters and the API
# rejects consecutive hyphens. The durable store's id is the long one at 38/40.
# Default name_suffix ("") gives the cache store.
# -----------------------------------------------------------------------------
run "redis_cache_group_id_is_qualified" {
  command = plan

  module {
    source = "./modules/redis"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.replication_group_id == "flylive-audio-production-redis"
    error_message = "Cache replication group id must be flylive-audio-production-redis (ticket 31 / D3)"
  }
}

run "redis_durable_group_id_is_qualified_and_fits_40_chars" {
  command = plan

  variables {
    name_suffix = "-durable"
  }

  module {
    source = "./modules/redis"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.replication_group_id == "flylive-audio-production-redis-durable"
    error_message = "Durable replication group id must be flylive-audio-production-redis-durable (ticket 31 / D3)"
  }

  assert {
    condition     = length(aws_elasticache_replication_group.main.replication_group_id) <= 40
    error_message = "ElastiCache replication group ids are capped at 40 characters by AWS."
  }

  assert {
    condition     = !strcontains(aws_elasticache_replication_group.main.replication_group_id, "--")
    error_message = "ElastiCache rejects consecutive hyphens in a replication group id."
  }
}

# -----------------------------------------------------------------------------
# IAM plus the two boot-critical paths. The log group and the SSM parameter
# prefix are the names whose renaming breaks instance BOOT rather than apply:
# the CloudWatch Agent config and fetch_ssm() in
# modules/autoscaling/user-data.sh are templated from the same local.env_prefix
# (passed in as the `name_prefix` template variable), and the IAM grants below
# must stay scoped to the same path or the agent gets AccessDenied and the
# secrets fetch comes back empty.
# -----------------------------------------------------------------------------
run "iam_names_and_boot_paths_are_qualified" {
  command = plan

  module {
    source = "./modules/iam"
  }

  assert {
    condition     = aws_iam_role.msab.name == "flylive-audio-production-ec2-role"
    error_message = "EC2 role must be named flylive-audio-production-ec2-role (ticket 31 / D3)"
  }

  assert {
    condition     = aws_iam_role.github_actions.name == "flylive-audio-production-github-actions"
    error_message = "GHA deploy role must be named flylive-audio-production-github-actions (ticket 31 / D5). Renaming it changes its ARN — the GitHub environment's AWS_DEPLOY_ROLE_ARN variable must be updated in lockstep at cutover."
  }

  assert {
    condition     = aws_cloudwatch_log_group.msab.name == "/flylive-audio-production/msab"
    error_message = "Log group must be /flylive-audio-production/msab, matching the CloudWatch Agent config that modules/autoscaling/main.tf templates into user-data.sh from local.env_prefix."
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.cloudwatch_logs.policy, "arn:aws:logs:*:*:log-group:/flylive-audio-production/*")
    error_message = "The logs grant must be scoped to the SAME env-qualified path as the log group, or the CloudWatch Agent gets AccessDenied and silently stops shipping logs."
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.ssm_parameters.policy, "arn:aws:ssm:*:*:parameter/flylive-audio-production/*")
    error_message = "The SSM grant must be scoped to the SAME env-qualified prefix the instance reads at boot, or fetch_ssm() returns empty secrets and the boot gate fails."
  }
}

run "iam_names_are_qualified_under_the_staging_shape" {
  command = plan

  variables {
    environment = "staging"
  }

  module {
    source = "./modules/iam"
  }

  assert {
    condition     = aws_iam_role.msab.name == "flylive-audio-staging-ec2-role"
    error_message = "EC2 role must be named flylive-audio-staging-ec2-role under the staging shape"
  }

  assert {
    condition     = aws_cloudwatch_log_group.msab.name == "/flylive-audio-staging/msab"
    error_message = "Log group must be /flylive-audio-staging/msab under the staging shape"
  }
}

# -----------------------------------------------------------------------------
# The KMS alias is regional-unique, and the 7 parameter paths hold the secrets
# the instance reads at boot. Per decision D4 the key and alias are
# per-environment and never shared — a shared prefix here would let one
# environment read the other's secrets.
# -----------------------------------------------------------------------------
run "ssm_alias_and_parameter_paths_are_qualified" {
  command = plan

  module {
    source = "./modules/ssm"
  }

  assert {
    condition     = aws_kms_alias.ssm.name == "alias/flylive-audio-production-ssm"
    error_message = "KMS alias must be alias/flylive-audio-production-ssm (ticket 31 / D4 — keys and aliases are per-environment, never shared)"
  }

  assert {
    condition     = aws_ssm_parameter.jwt_secret.name == "/flylive-audio-production/jwt-secret"
    error_message = "SSM parameters must live under /flylive-audio-production/ — a shared prefix would cross-contaminate staging and production secrets."
  }
}

# =============================================================================
# THE SHARED SET (decision D2) — these must NOT be qualified
# =============================================================================

run "ecr_repository_name_is_environment_neutral" {
  command = plan

  module {
    source = "./modules/ecr"
  }

  assert {
    condition     = aws_ecr_repository.msab.name == "flylive-audio/msab"
    error_message = "The ECR repository is account-global-SHARED (decision D2) and already applied. Renaming it forces a replace that destroys every image both environments boot from."
  }

  assert {
    condition     = !strcontains(aws_ecr_repository.msab.name, "production")
    error_message = "The ECR repository name must never carry an environment token — it is shared by staging and production by design (decision D2)."
  }

  # The lifecycle policy is the second half of the surgery pair in decision D2
  # (state rm from staging, import into prod), so it has to stay attached to
  # the same unqualified repository. Its rule bodies select on image TAG
  # prefixes ("sha-"), not on the repository name — the repository linkage is
  # the thing worth pinning here.
  assert {
    condition     = aws_ecr_lifecycle_policy.msab.repository == "flylive-audio/msab"
    error_message = "The ECR lifecycle policy must stay attached to the unqualified shared repository (decision D2) — it is imported into the production state alongside the repo itself."
  }

  # There is no staging counterpart to this run on purpose. modules/ecr does
  # not DECLARE an `environment` variable at all (see the comment on the
  # module "ecr" block in main.tf), so there is no staging shape to flip it
  # into — passing one only produces a "value for undeclared variable"
  # warning. That absence is the structural guarantee; these assertions are
  # the behavioural backstop if someone ever adds the variable.
}

run "github_oidc_provider_url_is_environment_neutral" {
  command = plan

  variables {
    environment = "staging"
  }

  module {
    source = "./modules/iam"
  }

  # AWS allows exactly ONE OIDC provider per account per URL, so this resource
  # is shared by both environments by construction (decision D2). Only the
  # ROLES that trust it are per-environment (decision D5).
  assert {
    condition     = aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com"
    error_message = "The GitHub OIDC identity provider is one-per-account-per-URL and account-global-SHARED (decision D2). Its URL must never take an environment token — deleting or re-keying it breaks CI for both environments."
  }
}
