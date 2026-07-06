# =============================================================================
# FlyLive Audio Server (Vultr) — Single-region tracer (slice D)
# =============================================================================
# Stands up ONE region end-to-end: firewall, one instance, HA Valkey, a load
# balancer terminating TLS at 443. Multi-instance-per-region cascade is slice
# 05; the 3-region staging replica is slice 06 — both extend this file by
# looping module calls over `fleet_regions`/`for_each`, not by restructuring it.
# =============================================================================

module "networking" {
  source = "./modules/networking"

  project_name = var.project_name
  environment  = var.environment
  region       = var.tracer_region
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "valkey" {
  source = "./modules/valkey"

  project_name   = var.project_name
  environment    = var.environment
  region         = var.tracer_region
  valkey_plan    = var.valkey_plan
  valkey_version = var.valkey_version
}

module "compute" {
  source = "./modules/compute"

  project_name      = var.project_name
  environment       = var.environment
  region            = var.tracer_region
  instance_plan     = var.instance_plan
  firewall_group_id = module.networking.firewall_group_id
  vpc_ids           = [module.networking.vpc_id]
  app_port          = var.app_port
  rtc_min_port      = var.rtc_min_port
  rtc_max_port      = var.rtc_max_port

  image_tag       = var.image_tag
  ghcr_pull_token = var.ghcr_pull_token

  laravel_internal_key    = var.laravel_internal_key
  jwt_secret              = var.jwt_secret
  session_secret          = var.session_secret
  laravel_api_url         = var.laravel_api_url
  cors_origins            = var.cors_origins
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  cloudflare_turn_key_id  = var.cloudflare_turn_key_id
  mediasoup_num_workers   = var.mediasoup_num_workers

  redis_host     = module.valkey.host
  redis_port     = module.valkey.port
  redis_password = module.valkey.password

  broadcast_hls_enabled    = var.broadcast_hls_enabled
  hls_r2_endpoint          = var.hls_r2_endpoint
  hls_r2_bucket            = var.hls_r2_bucket
  hls_public_base_url      = var.hls_public_base_url
  hls_r2_access_key_id     = var.hls_r2_access_key_id
  hls_r2_secret_access_key = var.hls_r2_secret_access_key
}

module "loadbalancer" {
  source = "./modules/loadbalancer"

  project_name = var.project_name
  environment  = var.environment
  region       = var.tracer_region
  app_port     = var.app_port
  instance_ids = [module.compute.instance_id]
  vpc_id       = module.networking.vpc_id
  hostname     = var.tracer_hostname

  ssl_certificate = var.lb_ssl_certificate
  ssl_private_key = var.lb_ssl_private_key
  ssl_chain       = var.lb_ssl_chain

  allowed_sources = var.lb_allowed_sources
}
