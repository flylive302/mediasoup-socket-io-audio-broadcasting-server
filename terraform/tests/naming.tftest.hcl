# =============================================================================
# Resource naming, ROOT shape — staging and production names never collide
# (aws-production ticket 31, executes decision D3)
# =============================================================================
# WHY THIS FILE EXISTS
#
# ADR 0028 puts staging AND production in ONE AWS account (505307260926),
# keyed by state file. Before ticket 31 both environments rendered byte-
# identical names for every globally- or account-uniquely-named resource, so
# the SECOND environment's apply would have died on EntityAlreadyExists — or
# worse, silently shared the first environment's resources. Neither plan
# catches that alone: each environment's plan is internally consistent, and
# the collision exists only ACROSS the two states. That is the gap these runs
# close — they plan BOTH shapes and compare them.
#
# Renaming later is not an option: replication group ids, the NLB, the target
# group and the IAM names are force-replacement arguments, so renaming a live
# production stack is an outage. These assertions keep the qualification in.
#
# WHY THE MODULE-SCOPED ASSERTIONS LIVE IN A SIBLING FILE
#
# tests/naming_modules.tftest.hcl holds the per-module runs (exact names,
# length limits, and the D2 shared-set pins). A module-scoped `module {}`
# block re-types the mock providers for the WHOLE file it lives in, which
# collides with the `cloudflare` mock this root-scoped file needs — the same
# reason tests/log_retention.tftest.hcl and tests/ssl_validation.tftest.hcl
# are standalone files.
#
# HOW TO MUTATION-CHECK THIS FILE (do this if you change it)
#
#   Revert any single alarm name in modules/cloudwatch, modules/autoscaling or
#   modules/queues to "$${var.project_name}-..." — the staging run and the
#   disjointness run must BOTH go red.
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

mock_provider "aws" {
  alias = "mumbai"

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

mock_provider "aws" {
  alias = "frankfurt"

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

mock_provider "aws" {
  alias = "singapore"

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

mock_provider "cloudflare" {}

# Same offline fixture set as tests/plan_assertions.tftest.hcl — see the
# comments there for why each seam is needed (CAA override, checked-in SSH
# public key, required no-default secrets).
variables {
  project_name       = "flylive-audio"
  environment        = "production"
  audio_domain       = "audio.flyliveapp.com"
  cloudflare_zone_id = "mock-zone-id"

  caa_records_override = []
  ssh_public_key_path  = "./tests/fixtures/id_ed25519.pub"

  redis_auth_token     = "test-redis-auth-token-0123456789ab"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret           = "test-jwt-secret-0123456789abcdef"
  cloudflare_api_token = "test-cloudflare-api-token-0123456789ab"

  image_tag = "sha-deadbeef"
}

# -----------------------------------------------------------------------------
# PRODUCTION SHAPE — every alarm name the stack declares (root output
# alarm_names: the CloudWatch + autoscaling alarms of every enabled region,
# plus the 3 from the global queues module) must carry the production token.
#
# alarm_name is a CONFIGURED argument, so it is known at plan time even under
# a mock provider — unlike ARNs and DNS names, which are computed and would be
# unknown here.
# -----------------------------------------------------------------------------
run "production_alarm_names_are_environment_qualified" {
  command = plan

  variables {
    environment = "production"
  }

  assert {
    condition = alltrue([
      for n in output.alarm_names : startswith(n, "flylive-audio-production-")
    ])
    error_message = "Every alarm name must start with \"flylive-audio-production-\" (ticket 31 / D3). An unqualified alarm name collides with the staging stack in the same AWS account."
  }

  # Representative exact names, one per declaring module — exact-literal pins,
  # deliberately NOT pattern matches (ticket 31 Trap 5: update assertions to
  # the new names, never loosen them to regex-anything).
  assert {
    condition     = contains(output.alarm_names, "flylive-audio-production-zero-healthy-hosts")
    error_message = "modules/autoscaling zero_healthy_hosts alarm must be named flylive-audio-production-zero-healthy-hosts"
  }

  assert {
    condition     = contains(output.alarm_names, "flylive-audio-production-event-loop-lag-p99")
    error_message = "modules/cloudwatch event_loop_lag_p99 alarm must be named flylive-audio-production-event-loop-lag-p99"
  }

  assert {
    condition     = contains(output.alarm_names, "flylive-audio-production-msab-events-dlq-messages")
    error_message = "modules/queues DLQ alarm must be named flylive-audio-production-msab-events-dlq-messages"
  }
}

# -----------------------------------------------------------------------------
# STAGING SHAPE — the same plan, one variable different. This is the half that
# could never have been proven before D3.
# -----------------------------------------------------------------------------
run "staging_alarm_names_are_environment_qualified" {
  command = plan

  variables {
    environment = "staging"
  }

  assert {
    condition = alltrue([
      for n in output.alarm_names : startswith(n, "flylive-audio-staging-")
    ])
    error_message = "Every alarm name must start with \"flylive-audio-staging-\" when environment=staging (ticket 31 / D3)."
  }

  assert {
    condition     = contains(output.alarm_names, "flylive-audio-staging-zero-healthy-hosts")
    error_message = "modules/autoscaling zero_healthy_hosts alarm must be named flylive-audio-staging-zero-healthy-hosts under the staging shape"
  }
}

# -----------------------------------------------------------------------------
# THE ACTUAL D3 GUARANTEE — the two environments' name sets must not overlap
# at all. Referencing two earlier runs' outputs is the only place the
# cross-state collision (invisible to either plan alone) becomes assertable.
#
# This goes red if ANY single alarm name loses its environment token, even one
# the exact-literal pins above do not name.
# -----------------------------------------------------------------------------
run "staging_and_production_names_never_collide" {
  command = plan

  assert {
    condition = length(setintersection(
      toset(run.production_alarm_names_are_environment_qualified.alarm_names),
      toset(run.staging_alarm_names_are_environment_qualified.alarm_names),
    )) == 0
    error_message = "Staging and production declare at least one IDENTICAL name. Both environments live in ONE AWS account (ADR 0028) — an identical name is the EntityAlreadyExists failure decision D3 exists to prevent."
  }

  # Non-vacuity: setintersection of two EMPTY sets is also empty, so the
  # assertion above would pass if alarm_names were somehow empty. Pin that it
  # is not.
  assert {
    condition     = length(run.production_alarm_names_are_environment_qualified.alarm_names) >= 15
    error_message = "Expected at least 15 declared alarm names; got fewer, so the disjointness assertion above is vacuous. Did a module get gated out of the plan?"
  }
}
