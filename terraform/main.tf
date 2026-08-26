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
  affinity_enabled                      = var.affinity_enabled
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
  manage_audio_dns                      = var.manage_audio_dns
  manage_instance_dns                   = var.manage_instance_dns
  instance_tls_certificate              = var.instance_tls_certificate
  instance_tls_private_key              = var.instance_tls_private_key
  instance_tls_chain                    = var.instance_tls_chain
  cloudflare_api_token                  = var.cloudflare_api_token
  caa_records_override                  = var.caa_records_override
  instance_type                         = var.instance_type
  instance_architecture                 = var.instance_architecture
  ssh_public_key_path                   = var.ssh_public_key_path
  laravel_internal_key                  = var.laravel_internal_key
  jwt_secret                            = var.jwt_secret
  jwt_secret_previous                   = var.jwt_secret_previous
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

  # aws-production/28 Phase A step 5 — arm the instance's SQS consumer.
  # The queue is global (one FIFO for every region, ADR 0029) and its URL is a
  # terraform OUTPUT, so this needs no prod.tfvars entry and no TF_VARS_PROD
  # re-paste. Additive: EVENT_HTTP_INGEST_ENABLED stays true, so HTTP ingest
  # remains the live transport until Laravel's producer is provisioned and
  # MSAB_TRANSPORT flips (ticket 29). Before this line the fleet had NO
  # EVENT_QUEUE_URL at all — the consumer was inert while the runbook recorded
  # it as armed "from the first serving minute".
  event_queue_url = module.queues.queue_url

  # Sentry (env-diff finding 2026-08-18) — inert while sentry_dsn is "".
  sentry_dsn = var.sentry_dsn

  # aws-production/08 — the msab SG's port-9100 ingress-from-loadgen rule.
  # loadgen_ingress_enabled is computed here (root scope) from root variables
  # ONLY, never from module.loadgen's own output — that output is unknown at
  # plan time whenever this would be true, and it can't gate a for_each (see
  # modules/networking/variables.tf).
  #
  # The null -> "" conversion below is a plain conditional, NOT coalesce() —
  # confirmed empirically (tests/redis_store_split.tftest.hcl and others broke
  # with "Call to function coalesce failed: no non-null, non-empty-string
  # arguments"): coalesce(x, "") ERRORS when x is null, because "" doesn't
  # count as a valid fallback value either — coalesce needs at least one
  # argument that is non-null AND non-empty, and here neither is. try() would
  # ALSO be wrong (try() catches errors, not null: try(null, "") still
  # evaluates to null, not "" — see modules/loadgen/outputs.tf's genuinely
  # error-raising try() cases for the contrast, e.g. indexing a possibly-empty
  # list). An explicit equality check is the correct tool for "null becomes a
  # specific default, including an empty-string default."
  loadgen_ingress_enabled   = var.loadgen_enabled && var.environment == "staging"
  loadgen_security_group_id = module.loadgen.security_group_id == null ? "" : module.loadgen.security_group_id
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
  affinity_enabled                      = var.affinity_enabled
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
  manage_audio_dns                      = var.manage_audio_dns
  manage_instance_dns                   = var.manage_instance_dns
  instance_tls_certificate              = var.instance_tls_certificate
  instance_tls_private_key              = var.instance_tls_private_key
  instance_tls_chain                    = var.instance_tls_chain
  cloudflare_api_token                  = var.cloudflare_api_token
  caa_records_override                  = var.caa_records_override
  instance_type                         = var.instance_type
  instance_architecture                 = var.instance_architecture
  ssh_public_key_path                   = var.ssh_public_key_path
  laravel_internal_key                  = var.laravel_internal_key
  jwt_secret                            = var.jwt_secret
  jwt_secret_previous                   = var.jwt_secret_previous
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

  # aws-production/28 Phase A step 5 — arm the instance's SQS consumer.
  # The queue is global (one FIFO for every region, ADR 0029) and its URL is a
  # terraform OUTPUT, so this needs no prod.tfvars entry and no TF_VARS_PROD
  # re-paste. Additive: EVENT_HTTP_INGEST_ENABLED stays true, so HTTP ingest
  # remains the live transport until Laravel's producer is provisioned and
  # MSAB_TRANSPORT flips (ticket 29). Before this line the fleet had NO
  # EVENT_QUEUE_URL at all — the consumer was inert while the runbook recorded
  # it as armed "from the first serving minute".
  event_queue_url = module.queues.queue_url

  # Sentry (env-diff finding 2026-08-18) — inert while sentry_dsn is "".
  sentry_dsn = var.sentry_dsn
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
  affinity_enabled                      = var.affinity_enabled
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
  manage_audio_dns                      = var.manage_audio_dns
  manage_instance_dns                   = var.manage_instance_dns
  instance_tls_certificate              = var.instance_tls_certificate
  instance_tls_private_key              = var.instance_tls_private_key
  instance_tls_chain                    = var.instance_tls_chain
  cloudflare_api_token                  = var.cloudflare_api_token
  caa_records_override                  = var.caa_records_override
  instance_type                         = var.instance_type
  instance_architecture                 = var.instance_architecture
  ssh_public_key_path                   = var.ssh_public_key_path
  laravel_internal_key                  = var.laravel_internal_key
  jwt_secret                            = var.jwt_secret
  jwt_secret_previous                   = var.jwt_secret_previous
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

  # aws-production/28 Phase A step 5 — arm the instance's SQS consumer.
  # The queue is global (one FIFO for every region, ADR 0029) and its URL is a
  # terraform OUTPUT, so this needs no prod.tfvars entry and no TF_VARS_PROD
  # re-paste. Additive: EVENT_HTTP_INGEST_ENABLED stays true, so HTTP ingest
  # remains the live transport until Laravel's producer is provisioned and
  # MSAB_TRANSPORT flips (ticket 29). Before this line the fleet had NO
  # EVENT_QUEUE_URL at all — the consumer was inert while the runbook recorded
  # it as armed "from the first serving minute".
  event_queue_url = module.queues.queue_url

  # Sentry (env-diff finding 2026-08-18) — inert while sentry_dsn is "".
  sentry_dsn = var.sentry_dsn
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

# ⛔ This module deliberately takes NO `environment` argument. Under decision D3
# (ticket 31) every other module qualifies its resource names by environment so
# staging and production can coexist in one AWS account — but the ECR repository
# and its lifecycle policy are declared account-global-SHARED (decision D2) and
# are already applied. Renaming them forces a replace, which destroys the image
# warehouse both environments boot from. The absence of the argument is the
# guarantee: modules/ecr cannot see var.environment, so it cannot rename itself.
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
  environment  = var.environment
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
  environment      = var.environment
  alerts_topic_arn = module.alerting.alerts_topic_arn
}

# =============================================================================
# Load generator (aws-production/08) — test tooling, ROOT scope like alerting/
# queues above, deliberately NOT inside modules/region: it is not a per-region
# production resource, it targets exactly one region (mumbai, where staging's
# box under test lives) regardless of how many regions are enabled, and giving
# it its own module call keeps a future frankfurt/singapore loadgen instance
# an explicit, separate decision rather than something that rides along with
# enabled_regions.
#
# Uses the DEFAULT (unaliased) aws provider — no `providers = {...}` block —
# which main.tf's own provider block above pins to ap-south-1, i.e. the same
# region as mumbai. vpc_id/public_subnet_id below come from
# module.region_mumbai, so this only ever makes sense while "mumbai" is
# enabled; try() below turns a disabled-mumbai edge case into an empty string
# rather than a plan-time index error (harmless in practice — every real
# resource in modules/loadgen is ALSO count-gated to loadgen_enabled &&
# environment=="staging", so an empty vpc_id is never actually handed to AWS
# unless someone flips loadgen on for a region that isn't mumbai, which is
# out of scope for this ticket).
# =============================================================================

module "loadgen" {
  source = "./modules/loadgen"

  enabled      = var.loadgen_enabled
  environment  = var.environment
  project_name = var.project_name
  region       = local.regions.mumbai.aws_region

  vpc_id           = try(module.region_mumbai[0].vpc_id, "")
  public_subnet_id = try(module.region_mumbai[0].public_subnet_ids[0], "")

  # Reading the SecureString below needs kms:Decrypt on the CMK that encrypts it,
  # not just ssm:GetParameter. Same direction as vpc_id/public_subnet_id above
  # (loadgen consumes region), so this adds no dependency cycle.
  kms_key_arn = try(module.region_mumbai[0].ssm_kms_key_arn, "")

  instance_type  = var.loadgen_instance_type
  harness_s3_uri = var.loadgen_harness_s3_uri
  msab_app_port  = var.app_port

  # Same env-qualified path modules/ssm writes LARAVEL_INTERNAL_KEY to
  # ("/${local.env_prefix}/laravel-internal-key" — see that module's main.tf).
  # Not a module output: modules/ssm is instantiated per-region INSIDE
  # modules/region, and its own local.env_prefix is built from the identical
  # project_name+environment pair, so re-deriving the path here from the same
  # two root variables reaches the exact same parameter without adding a
  # region -> root output just for this one string.
  internal_key_ssm_path = "/${var.project_name}-${var.environment}/laravel-internal-key"
}

# =============================================================================
# IAM Role + Instance Profile (global — IAM is not regional)
# =============================================================================

module "iam" {
  source = "./modules/iam"

  project_name          = var.project_name
  environment           = var.environment
  ecr_repository_arn    = module.ecr.repository_arn
  ecr_pull_resource_arn = module.ecr.pull_resource_arn

  # Ticket 25: consume-side SQS access by IAM role, no shared secret.
  enable_event_queue_consume = true
  event_queue_arn            = module.queues.queue_arn

  # Ticket 29: send-only IAM user for Laravel (producer principal). Access
  # key is operator-created in the console — never terraform.
  enable_event_queue_produce = true

  # OIDC deploy role trust (ticket 12): which GitHub environment's jobs may
  # assume the deploy role. Staging must point at its own GitHub environment
  # so a staging run can never assume the production role (and vice versa).
  github_environment = var.github_deploy_environment
}
