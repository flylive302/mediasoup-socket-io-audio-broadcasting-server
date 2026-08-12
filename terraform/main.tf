# =============================================================================
# FlyLive Audio Server — Terraform Root Configuration
# =============================================================================
# Multi-region-capable, single-region-deployed (ticket 11): all three regions
# are defined in code, but only var.enabled_regions (default ["mumbai"]) render
# resources. Everything one region needs lives in modules/region — the three
# stanzas below exist only because Terraform cannot for_each over provider
# aliases; each is a thin gate, not a copy of the region.
# =============================================================================

terraform {
  # use_lockfile on the S3 backend requires Terraform >= 1.10; mock_provider in
  # tests/ requires >= 1.7 — 1.10 is the real floor (was wrongly ">= 1.5").
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state in S3 (created via scripts/aws/bootstrap-state.sh).
  # Single-account, key-per-environment layout (ADR 0028): one bucket, one state
  # key per environment. Bucket AND key MUST be supplied at init time — the
  # literals below are intentional placeholders that fail loudly if not overridden:
  #   ./scripts/aws/bootstrap-state.sh           # writes backend-{staging,production}.hcl
  #   terraform init -reconfigure -backend-config=backend-production.hcl
  #   terraform init -reconfigure -backend-config=backend-staging.hcl
  backend "s3" {
    bucket       = "REPLACED_BY_backend_hcl" # override via -backend-config=backend-<env>.hcl
    key          = "REPLACED_BY_backend_hcl" # env/<environment>/terraform.tfstate
    region       = "ap-south-1"
    use_lockfile = true
    encrypt      = true
  }
}

# =============================================================================
# Region metadata + CIDR allocation (ticket 11 — one-way once applied)
# =============================================================================
# Full allocation table: docs/issues/aws-platform-build/11-CIDR-ALLOCATION.md.
# Non-overlapping per region AND per environment so peering/transit routing
# never needs renumbering. 10.10.0.0/16 (old Vultr/legacy value) is retired.
# Second-region headroom: 10.23-10.29 (prod) / 10.123-10.129 (staging) reserved.

locals {
  regions = {
    mumbai    = { aws_region = "ap-south-1" }
    frankfurt = { aws_region = "eu-central-1" }
    singapore = { aws_region = "ap-southeast-1" }
  }

  vpc_cidrs = {
    production = {
      mumbai    = "10.20.0.0/16"
      frankfurt = "10.21.0.0/16"
      singapore = "10.22.0.0/16"
    }
    staging = {
      mumbai    = "10.120.0.0/16"
      frankfurt = "10.121.0.0/16"
      singapore = "10.122.0.0/16"
    }
  }

}

# =============================================================================
# Provider Aliases — one per region (must be static; cannot be iterated)
# =============================================================================

provider "aws" {
  alias  = "mumbai"
  region = "ap-south-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = var.environment
      Region      = "mumbai"
    }
  }
}

provider "aws" {
  alias  = "frankfurt"
  region = "eu-central-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = var.environment
      Region      = "frankfurt"
    }
  }
}

provider "aws" {
  alias  = "singapore"
  region = "ap-southeast-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = var.environment
      Region      = "singapore"
    }
  }
}

# Default provider (Mumbai) — used by global resources (ECR, SNS, IAM)
provider "aws" {
  region = "ap-south-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = var.environment
    }
  }
}

# Cloudflare — single global (unaliased) provider. The zone (and its DNS
# records / CAA data) is not regional, so every region's ssl module shares
# this one provider instance instead of getting its own alias.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# =============================================================================
# Regions — thin gated stanzas over modules/region (see header)
# =============================================================================

module "region_mumbai" {
  source    = "./modules/region"
  providers = { aws = aws.mumbai, cloudflare = cloudflare }
  count     = contains(var.enabled_regions, "mumbai") ? 1 : 0

  region_name           = "mumbai"
  aws_region            = local.regions.mumbai.aws_region
  vpc_cidr              = local.vpc_cidrs[var.environment].mumbai
  instance_profile_name = module.iam.instance_profile_name
  iam_role_name         = module.iam.role_name
  ecr_repo_url          = module.ecr.repository_url
  image_tag             = var.image_tag

  project_name                          = var.project_name
  environment                           = var.environment
  app_port                              = var.app_port
  rtc_min_port                          = var.rtc_min_port
  rtc_max_port                          = var.rtc_max_port
  cascade_ports_open                    = var.cascade_ports_open
  cascade_enabled                       = var.cascade_enabled
  redis_node_type                       = var.redis_node_type
  redis_durable_node_type               = var.redis_durable_node_type
  redis_durable_snapshot_retention_days = var.redis_durable_snapshot_retention_days
  redis_durable_snapshot_window         = var.redis_durable_snapshot_window
  redis_num_cache_clusters              = var.redis_num_cache_clusters
  redis_automatic_failover              = var.redis_automatic_failover
  redis_multi_az                        = var.redis_multi_az
  redis_durable_num_cache_clusters      = var.redis_durable_num_cache_clusters
  redis_durable_automatic_failover      = var.redis_durable_automatic_failover
  redis_durable_multi_az                = var.redis_durable_multi_az
  redis_auth_token                      = var.redis_auth_token
  audio_domain                          = var.audio_domain
  cloudflare_zone_id                    = var.cloudflare_zone_id
  caa_records_override                  = var.caa_records_override
  instance_type                         = var.instance_type
  instance_architecture                 = var.instance_architecture
  ssh_public_key_path                   = var.ssh_public_key_path
  laravel_internal_key                  = var.laravel_internal_key
  jwt_secret                            = var.jwt_secret
  session_secret                        = var.session_secret
  cloudflare_turn_api_key               = var.cloudflare_turn_api_key
  cloudflare_turn_key_id                = var.cloudflare_turn_key_id
  cors_origins                          = var.cors_origins
  laravel_api_url                       = var.laravel_api_url
  jwt_max_age_seconds                   = var.jwt_max_age_seconds
  laravel_api_timeout_ms                = var.laravel_api_timeout_ms
  ice_stun_urls                         = var.ice_stun_urls
  room_broadcast_threshold_up           = var.room_broadcast_threshold_up
  room_broadcast_threshold_down         = var.room_broadcast_threshold_down
  broadcast_hls_enabled                 = var.broadcast_hls_enabled
  hls_r2_endpoint                       = var.hls_r2_endpoint
  hls_r2_bucket                         = var.hls_r2_bucket
  hls_public_base_url                   = var.hls_public_base_url
  hls_r2_access_key_id                  = var.hls_r2_access_key_id
  hls_r2_secret_access_key              = var.hls_r2_secret_access_key
  fleet_size                            = var.fleet_size
  alerts_topic_arn                      = module.alerting.alerts_topic_arn
}

module "region_frankfurt" {
  source    = "./modules/region"
  providers = { aws = aws.frankfurt, cloudflare = cloudflare }
  count     = contains(var.enabled_regions, "frankfurt") ? 1 : 0

  region_name           = "frankfurt"
  aws_region            = local.regions.frankfurt.aws_region
  vpc_cidr              = local.vpc_cidrs[var.environment].frankfurt
  instance_profile_name = module.iam.instance_profile_name
  iam_role_name         = module.iam.role_name
  ecr_repo_url          = module.ecr.repository_url
  image_tag             = var.image_tag

  project_name                          = var.project_name
  environment                           = var.environment
  app_port                              = var.app_port
  rtc_min_port                          = var.rtc_min_port
  rtc_max_port                          = var.rtc_max_port
  cascade_ports_open                    = var.cascade_ports_open
  cascade_enabled                       = var.cascade_enabled
  redis_node_type                       = var.redis_node_type
  redis_durable_node_type               = var.redis_durable_node_type
  redis_durable_snapshot_retention_days = var.redis_durable_snapshot_retention_days
  redis_durable_snapshot_window         = var.redis_durable_snapshot_window
  redis_num_cache_clusters              = var.redis_num_cache_clusters
  redis_automatic_failover              = var.redis_automatic_failover
  redis_multi_az                        = var.redis_multi_az
  redis_durable_num_cache_clusters      = var.redis_durable_num_cache_clusters
  redis_durable_automatic_failover      = var.redis_durable_automatic_failover
  redis_durable_multi_az                = var.redis_durable_multi_az
  redis_auth_token                      = var.redis_auth_token
  audio_domain                          = var.audio_domain
  cloudflare_zone_id                    = var.cloudflare_zone_id
  caa_records_override                  = var.caa_records_override
  instance_type                         = var.instance_type
  instance_architecture                 = var.instance_architecture
  ssh_public_key_path                   = var.ssh_public_key_path
  laravel_internal_key                  = var.laravel_internal_key
  jwt_secret                            = var.jwt_secret
  session_secret                        = var.session_secret
  cloudflare_turn_api_key               = var.cloudflare_turn_api_key
  cloudflare_turn_key_id                = var.cloudflare_turn_key_id
  cors_origins                          = var.cors_origins
  laravel_api_url                       = var.laravel_api_url
  jwt_max_age_seconds                   = var.jwt_max_age_seconds
  laravel_api_timeout_ms                = var.laravel_api_timeout_ms
  ice_stun_urls                         = var.ice_stun_urls
  room_broadcast_threshold_up           = var.room_broadcast_threshold_up
  room_broadcast_threshold_down         = var.room_broadcast_threshold_down
  broadcast_hls_enabled                 = var.broadcast_hls_enabled
  hls_r2_endpoint                       = var.hls_r2_endpoint
  hls_r2_bucket                         = var.hls_r2_bucket
  hls_public_base_url                   = var.hls_public_base_url
  hls_r2_access_key_id                  = var.hls_r2_access_key_id
  hls_r2_secret_access_key              = var.hls_r2_secret_access_key
  fleet_size                            = var.fleet_size
  alerts_topic_arn                      = module.alerting.alerts_topic_arn
}

module "region_singapore" {
  source    = "./modules/region"
  providers = { aws = aws.singapore, cloudflare = cloudflare }
  count     = contains(var.enabled_regions, "singapore") ? 1 : 0

  region_name           = "singapore"
  aws_region            = local.regions.singapore.aws_region
  vpc_cidr              = local.vpc_cidrs[var.environment].singapore
  instance_profile_name = module.iam.instance_profile_name
  iam_role_name         = module.iam.role_name
  ecr_repo_url          = module.ecr.repository_url
  image_tag             = var.image_tag

  project_name                          = var.project_name
  environment                           = var.environment
  app_port                              = var.app_port
  rtc_min_port                          = var.rtc_min_port
  rtc_max_port                          = var.rtc_max_port
  cascade_ports_open                    = var.cascade_ports_open
  cascade_enabled                       = var.cascade_enabled
  redis_node_type                       = var.redis_node_type
  redis_durable_node_type               = var.redis_durable_node_type
  redis_durable_snapshot_retention_days = var.redis_durable_snapshot_retention_days
  redis_durable_snapshot_window         = var.redis_durable_snapshot_window
  redis_num_cache_clusters              = var.redis_num_cache_clusters
  redis_automatic_failover              = var.redis_automatic_failover
  redis_multi_az                        = var.redis_multi_az
  redis_durable_num_cache_clusters      = var.redis_durable_num_cache_clusters
  redis_durable_automatic_failover      = var.redis_durable_automatic_failover
  redis_durable_multi_az                = var.redis_durable_multi_az
  redis_auth_token                      = var.redis_auth_token
  audio_domain                          = var.audio_domain
  cloudflare_zone_id                    = var.cloudflare_zone_id
  caa_records_override                  = var.caa_records_override
  instance_type                         = var.instance_type
  instance_architecture                 = var.instance_architecture
  ssh_public_key_path                   = var.ssh_public_key_path
  laravel_internal_key                  = var.laravel_internal_key
  jwt_secret                            = var.jwt_secret
  session_secret                        = var.session_secret
  cloudflare_turn_api_key               = var.cloudflare_turn_api_key
  cloudflare_turn_key_id                = var.cloudflare_turn_key_id
  cors_origins                          = var.cors_origins
  laravel_api_url                       = var.laravel_api_url
  jwt_max_age_seconds                   = var.jwt_max_age_seconds
  laravel_api_timeout_ms                = var.laravel_api_timeout_ms
  ice_stun_urls                         = var.ice_stun_urls
  room_broadcast_threshold_up           = var.room_broadcast_threshold_up
  room_broadcast_threshold_down         = var.room_broadcast_threshold_down
  broadcast_hls_enabled                 = var.broadcast_hls_enabled
  hls_r2_endpoint                       = var.hls_r2_endpoint
  hls_r2_bucket                         = var.hls_r2_bucket
  hls_public_base_url                   = var.hls_public_base_url
  hls_r2_access_key_id                  = var.hls_r2_access_key_id
  hls_r2_secret_access_key              = var.hls_r2_secret_access_key
  fleet_size                            = var.fleet_size
  alerts_topic_arn                      = module.alerting.alerts_topic_arn
}

# =============================================================================
# Global Accelerator — DROPPED (ticket 11 verdict, operator-approved 2026-08-10)
# =============================================================================
# Single-region launch: GA's nearest-region routing has nothing to route, it
# costs ~$18/mo + per-GB, and it forced the stickiness-disabled constraint
# (TIER0 F-85). Clients reach the Mumbai NLB directly via DNS. Re-evaluate only
# when a second region actually turns on (modules/global-accelerator removed;
# recover from git history if ever needed).

# =============================================================================
# Global: ECR Container Registry (one repo, enabled regions pull from it)
# =============================================================================

module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name

  # Replicate pushed images into every ENABLED consuming region so instances
  # pull from a LOCAL registry. Mumbai is the home registry — excluded.
  # NOTE: replication only copies images pushed AFTER the rule exists — a newly
  # enabled region's replica is empty until the next build-and-push.
  replication_destination_regions = [
    for name, meta in local.regions : meta.aws_region
    if contains(var.enabled_regions, name) && name != "mumbai"
  ]
}

# =============================================================================
# Global: Alerting — single SNS topic every region + module.queues notify
# (ticket 32). See modules/alerting/main.tf header for why this is global
# rather than living inside the regional modules/cloudwatch: a topic there
# would cycle (queues -> region -> iam -> queues) and collide by name across
# a second enabled region.
# =============================================================================

module "alerting" {
  source = "./modules/alerting"

  project_name = var.project_name
  alert_email  = var.alert_email
}

# =============================================================================
# Queues: SQS FIFO bridge for economy events (ticket 25, shape = ADR 0029)
# The SNS event-bus module that used to sit here was retired by ticket 28
# (2026-08-11): it was never applied and never carried traffic — Laravel
# delivers via direct authenticated POST, moving to this queue at cutover.
# =============================================================================

module "queues" {
  source = "./modules/queues"

  project_name     = var.project_name
  alerts_topic_arn = module.alerting.alerts_topic_arn
}

# =============================================================================
# IAM Role + Instance Profile (global — IAM is not regional)
# =============================================================================

module "iam" {
  source = "./modules/iam"

  project_name          = var.project_name
  ecr_repository_arn    = module.ecr.repository_arn
  ecr_pull_resource_arn = module.ecr.pull_resource_arn

  # Ticket 25: consume-side SQS access by IAM role, no shared secret.
  enable_event_queue_consume = true
  event_queue_arn            = module.queues.queue_arn

  # OIDC deploy role trust (ticket 12): which GitHub environment's jobs may
  # assume the deploy role. Staging must point at its own GitHub environment
  # so a staging run can never assume the production role (and vice versa).
  github_environment = var.github_deploy_environment
}
