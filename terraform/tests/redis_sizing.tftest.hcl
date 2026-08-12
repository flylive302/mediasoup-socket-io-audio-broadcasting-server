# =============================================================================
# Redis sizing/HA per environment — rendered-plan assertions (aws-production/01)
# =============================================================================
# Offline, mocked providers — same harness as redis_store_split.tftest.hcl.
# Asserts through the plan-known `redis_cache_config` / `redis_durable_config`
# region outputs, whose sizing fields are single direct `var.` references to the
# matching aws_elasticache_replication_group attributes (modules/redis/main.tf).
# Module-scoped runs are deliberately avoided — see the provider-type-mismatch
# trap documented in redis_store_split.tftest.hcl.
#
# The no-diff guarantee this file pins: production sets NONE of these variables,
# so the defaults must stay bit-identical to the pre-ticket module literals
# (cache.r7g.large, 2 nodes, multi-AZ, automatic failover) on BOTH stores.
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

  redis_auth_token     = "test-redis-auth-token-0123456789ab"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret           = "test-jwt-secret-0123456789abcdef"
  cloudflare_api_token = "test-cloudflare-api-token-0123456789ab"

  image_tag = "sha-deadbeef"
}

# --- THE NO-DIFF GUARD: with no redis sizing vars set (= production), both
# --- stores must render the exact pre-ticket literals. Any drift here is the
# --- same drift `plan -var-file=prod.tfvars` would show. ---
run "production_defaults_equal_the_pre_ticket_literals" {
  command = plan

  assert {
    condition = alltrue([
      module.region_mumbai[0].redis_cache_config.node_type == "cache.r7g.large",
      module.region_mumbai[0].redis_cache_config.num_cache_clusters == 2,
      module.region_mumbai[0].redis_cache_config.automatic_failover_enabled == true,
      module.region_mumbai[0].redis_cache_config.multi_az_enabled == true,
    ])
    error_message = "CACHE store defaults drifted from the pre-ticket literals (cache.r7g.large / 2 nodes / failover / multi-AZ) — production would plan a diff."
  }

  assert {
    condition = alltrue([
      module.region_mumbai[0].redis_durable_config.node_type == "cache.r7g.large",
      module.region_mumbai[0].redis_durable_config.num_cache_clusters == 2,
      module.region_mumbai[0].redis_durable_config.automatic_failover_enabled == true,
      module.region_mumbai[0].redis_durable_config.multi_az_enabled == true,
    ])
    error_message = "DURABLE store defaults drifted from the pre-ticket literals — production would plan a diff."
  }
}

# --- Staging profile: single node, no HA, small class, on BOTH stores ---
run "staging_profile_is_single_node_no_ha" {
  command = plan

  variables {
    redis_node_type          = "cache.t4g.micro"
    redis_num_cache_clusters = 1
    redis_automatic_failover = false
    redis_multi_az           = false

    redis_durable_node_type          = "cache.t4g.small"
    redis_durable_num_cache_clusters = 1
    redis_durable_automatic_failover = false
    redis_durable_multi_az           = false
  }

  assert {
    condition = alltrue([
      module.region_mumbai[0].redis_cache_config.node_type == "cache.t4g.micro",
      module.region_mumbai[0].redis_cache_config.num_cache_clusters == 1,
      module.region_mumbai[0].redis_cache_config.automatic_failover_enabled == false,
      module.region_mumbai[0].redis_cache_config.multi_az_enabled == false,
    ])
    error_message = "Staging cache store must plan a single small node with no multi-AZ — HA here is the ~$650/mo the ticket exists to remove."
  }

  assert {
    condition = alltrue([
      module.region_mumbai[0].redis_durable_config.node_type == "cache.t4g.small",
      module.region_mumbai[0].redis_durable_config.num_cache_clusters == 1,
      module.region_mumbai[0].redis_durable_config.automatic_failover_enabled == false,
      module.region_mumbai[0].redis_durable_config.multi_az_enabled == false,
    ])
    error_message = "Staging durable store must plan a single small node with no multi-AZ."
  }

  # Turning HA down must NOT turn durability off — ticket 21's split survives.
  assert {
    condition = alltrue([
      module.region_mumbai[0].redis_durable_config.maxmemory_policy == "noeviction",
      module.region_mumbai[0].redis_durable_config.snapshot_retention_limit > 0,
    ])
    error_message = "Staging's cheap profile must not disturb the durable store's noeviction + snapshots (aws-platform-build/21)."
  }
}

# --- Durable store sizes independently of the cache store ---
run "durable_store_can_size_independently" {
  command = plan

  variables {
    redis_num_cache_clusters         = 1
    redis_automatic_failover         = false
    redis_multi_az                   = false
    redis_durable_num_cache_clusters = 2
  }

  assert {
    condition     = module.region_mumbai[0].redis_durable_config.num_cache_clusters == 2
    error_message = "Durable store must be able to keep 2 nodes while the cache store runs 1."
  }

  assert {
    condition     = module.region_mumbai[0].redis_cache_config.num_cache_clusters == 1
    error_message = "Cache store must stay at 1 node when only the durable store is sized up."
  }
}

# --- Bad combinations fail at PLAN, not at apply
# --- (lifecycle preconditions in modules/redis/main.tf) ---
run "failover_on_a_single_node_is_rejected_at_plan" {
  command = plan

  variables {
    redis_num_cache_clusters = 1
    redis_automatic_failover = true
    redis_multi_az           = false
  }

  # Root-level variable validation (variables.tf). The module carries the same
  # rule as a lifecycle precondition for reuse; only the root-level object is
  # addressable from `terraform test`.
  expect_failures = [
    var.redis_automatic_failover,
  ]
}

run "multi_az_without_failover_is_rejected_at_plan" {
  command = plan

  variables {
    redis_num_cache_clusters = 2
    redis_automatic_failover = false
    redis_multi_az           = true
  }

  expect_failures = [
    var.redis_multi_az,
  ]
}
