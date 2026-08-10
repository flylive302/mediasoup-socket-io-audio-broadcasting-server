# =============================================================================
# Durable/cache store split — rendered-plan assertions (aws-platform-build/21)
# =============================================================================
# Offline, mocked providers — same harness as plan_assertions.tftest.hcl.
# Asserts the ticket's ACs from ROOT-level runs via the plan-known
# `redis_durable_config` / `redis_cache_config` region outputs (var-derived,
# so known at plan). Module-scoped runs are deliberately avoided here: a run
# against a module that doesn't declare the cloudflare provider re-types the
# suite-wide "cloudflare" mock as hashicorp/cloudflare and breaks every other
# file — see the provider-type-mismatch trap this file's first version hit.
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
  # plan_assertions.tftest.hcl).
  redis_auth_token     = "test-redis-auth-token-0123456789ab"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret           = "test-jwt-secret-0123456789abcdef"
  cloudflare_api_token = "test-cloudflare-api-token-0123456789ab"
}

# --- Durable store never evicts and is snapshotted, retention AND window
# --- explicit (modules/region/main.tf `redis_durable` → modules/redis) ---
run "durable_store_is_noeviction_and_snapshotted" {
  command = plan

  assert {
    condition     = module.region_mumbai[0].redis_durable_config.maxmemory_policy == "noeviction"
    error_message = "Durable store must use maxmemory-policy=noeviction — evicting gifts:pending loses in-flight money."
  }

  assert {
    condition     = module.region_mumbai[0].redis_durable_config.snapshot_retention_limit > 0
    error_message = "Durable store must retain automated snapshots — they are the only backup of the money queue."
  }

  assert {
    condition     = module.region_mumbai[0].redis_durable_config.snapshot_window == "21:00-22:00"
    error_message = "Durable store snapshot_window must be set explicitly (21:00-22:00 UTC ≈ 02:00-03:00 PKT, off-peak)."
  }
}

# --- Cache store unchanged: evict-freely, no backups, original name ---
run "cache_store_still_evicts_freely_no_backups" {
  command = plan

  assert {
    condition     = module.region_mumbai[0].redis_cache_config.maxmemory_policy == "allkeys-lru"
    error_message = "Cache store must keep allkeys-lru — only the durable store pins memory."
  }

  assert {
    condition     = module.region_mumbai[0].redis_cache_config.snapshot_retention_limit == 0
    error_message = "Cache store must not pay for snapshots — durability lives on the durable store."
  }

  assert {
    condition     = module.region_mumbai[0].redis_cache_config.replication_group_id == "flylive-audio-redis"
    error_message = "Cache store keeps the original -redis name (greenfield; no rename churn)."
  }
}

# --- The two stores are distinct replication groups ---
run "stores_are_two_distinct_groups" {
  command = plan

  assert {
    condition     = module.region_mumbai[0].redis_durable_config.replication_group_id != module.region_mumbai[0].redis_cache_config.replication_group_id
    error_message = "Durable and cache stores must be two separately configured replication groups, not one (ticket 21 decision)."
  }

  assert {
    condition     = module.region_mumbai[0].redis_durable_config.replication_group_id == "flylive-audio-redis-durable"
    error_message = "Durable store must carry the -durable suffix on its replication group."
  }
}

# --- A durable store without snapshots is refused at plan
# --- (variables.tf root validation; modules/region mirrors it) ---
run "zero_durable_retention_is_rejected" {
  command = plan

  variables {
    redis_durable_snapshot_retention_days = 0
  }

  expect_failures = [
    var.redis_durable_snapshot_retention_days,
  ]
}
