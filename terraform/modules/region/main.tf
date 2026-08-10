# =============================================================================
# Region composite module — everything one MSAB region needs (ticket 11)
# =============================================================================
# The per-region resource set is expressed ONCE, here. The root module
# instantiates it three times only because Terraform cannot for_each over
# provider aliases — each call site is a thin stanza gated by
# `contains(var.enabled_regions, "<name>")`, so disabled regions render zero
# resources. All submodules inherit this module's single (aliased) provider.
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

module "networking" {
  source = "../networking"

  project_name       = var.project_name
  vpc_cidr           = var.vpc_cidr
  app_port           = var.app_port
  rtc_min_port       = var.rtc_min_port
  rtc_max_port       = var.rtc_max_port
  cascade_ports_open = var.cascade_ports_open
}

module "redis" {
  source = "../redis"

  project_name            = var.project_name
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking.private_subnet_ids
  redis_security_group_id = module.networking.redis_security_group_id
  redis_auth_token        = var.redis_auth_token
}

module "ssl" {
  source = "../ssl"

  project_name = var.project_name
  audio_domain = var.audio_domain
}

module "loadbalancer" {
  source = "../loadbalancer"

  project_name      = var.project_name
  vpc_id            = module.networking.vpc_id
  public_subnet_ids = module.networking.public_subnet_ids
  app_port          = var.app_port
  certificate_arn   = module.ssl.certificate_arn
  # instance_id omitted — ASG manages target group registration
}

# Secrets replicated into this region's SSM (SSM Parameter Store is regional —
# without this, instances boot with empty secrets: Redis AUTH fails → 503 loop).
module "ssm" {
  source = "../ssm"

  project_name            = var.project_name
  jwt_secret              = var.jwt_secret
  laravel_internal_key    = var.laravel_internal_key
  session_secret          = var.session_secret
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  redis_auth_token        = var.redis_auth_token

  broadcast_hls_enabled    = var.broadcast_hls_enabled
  hls_r2_access_key_id     = var.hls_r2_access_key_id
  hls_r2_secret_access_key = var.hls_r2_secret_access_key
}

module "cloudwatch" {
  source = "../cloudwatch"

  project_name = var.project_name
  aws_region   = var.aws_region
}

module "autoscaling" {
  source = "../autoscaling"

  region                  = var.aws_region
  project_name            = var.project_name
  instance_type           = var.instance_type
  instance_architecture   = var.instance_architecture
  ssh_public_key_path     = var.ssh_public_key_path
  instance_profile_name   = var.instance_profile_name
  msab_security_group_id  = module.networking.msab_security_group_id
  public_subnet_ids       = module.networking.public_subnet_ids
  target_group_arn        = module.loadbalancer.target_group_arn
  ecr_repo_url            = var.ecr_repo_url
  app_port                = var.app_port
  rtc_min_port            = var.rtc_min_port
  rtc_max_port            = var.rtc_max_port
  redis_host              = module.redis.redis_host
  redis_port              = module.redis.redis_port
  laravel_internal_key    = var.laravel_internal_key
  jwt_secret              = var.jwt_secret
  session_secret          = var.session_secret
  audio_domain            = var.audio_domain
  cors_origins            = var.cors_origins
  laravel_api_url         = var.laravel_api_url
  cascade_enabled         = var.cascade_enabled
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  cloudflare_turn_key_id  = var.cloudflare_turn_key_id

  # MSAB Application Config
  jwt_max_age_seconds    = var.jwt_max_age_seconds
  laravel_api_timeout_ms = var.laravel_api_timeout_ms
  ice_stun_urls          = var.ice_stun_urls

  # realtime-08 broadcast flip thresholds (tunable for smoke tests).
  room_broadcast_threshold_up   = var.room_broadcast_threshold_up
  room_broadcast_threshold_down = var.room_broadcast_threshold_down

  # realtime-09 broadcast HLS tier (non-sensitive; R2 keys via SSM).
  broadcast_hls_enabled = var.broadcast_hls_enabled
  hls_r2_endpoint       = var.hls_r2_endpoint
  hls_r2_bucket         = var.hls_r2_bucket
  hls_public_base_url   = var.hls_public_base_url

  min_instances     = var.min_instances
  desired_instances = var.desired_instances
  max_instances     = var.max_instances

  # Zero Healthy Hosts alarm dimensions
  target_group_arn_suffix      = module.loadbalancer.target_group_arn_suffix
  load_balancer_arn_suffix     = module.loadbalancer.nlb_arn_suffix
  alarm_notification_topic_arn = module.cloudwatch.alerts_topic_arn
}
