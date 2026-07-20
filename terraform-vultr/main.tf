# =============================================================================
# FlyLive Audio Server (Vultr) — 3-region fleet (slice 06)
# =============================================================================
# Stands up the FULL region set in `var.fleet_regions` (Mumbai/Frankfurt/
# Singapore) — each region a complete stack: firewall + VPC, HA Valkey, a load
# balancer terminating TLS at 443, and a fixed HA fleet of `fleet_regions[r]`
# instances. Each instance gets its own reserved/announced IP and a unique CAS
# selfId, so intra-region cross-instance cascade (origin/edge) works, and a user
# in one region participating in a Room homed in another region reaches the
# correct regional LB (cross-region participation, driven by Laravel's
# config/realtime.php region routing).
#
# Slices D + E (04/05) stood up ONE region via un-keyed module calls. This slice
# loops those SAME module calls over `fleet_regions` with `for_each` — it does
# not restructure them. The un-keyed → keyed transition is state-migrated by the
# root `moved` blocks at the bottom so the live tracer region (its reserved IPs,
# instances and LB) is re-homed to the map key `var.tracer_region` rather than
# destroyed + recreated.
# =============================================================================

# --- Per-region LB hostnames -------------------------------------------------
# Laravel (config/realtime.php `regions` map) builds a Room's media endpoint as
# `wss://<city>.<sfu_domain>`, where <city> is one of mumbai/frankfurt/singapore.
# The regional LB's hostname (and its TLS cert SAN) MUST equal that exact host,
# or region routing resolves to a name that doesn't terminate here (AC#2/AC#3).
# This map is the Terraform side of that cross-file contract — keep it in lockstep
# with config/realtime.php's `regions` values.
locals {
  region_city = {
    bom = "mumbai"
    fra = "frankfurt"
    sgp = "singapore"
  }

  # region code -> LB hostname. An explicit `var.region_hostnames` entry wins;
  # otherwise derive `<city>.<audio_domain>` (e.g. mumbai.audio.staging.flyliveapp.com).
  region_hostnames = {
    for r in keys(var.fleet_regions) :
    r => try(var.region_hostnames[r], "${local.region_city[r]}.${var.audio_domain}")
  }
}

module "networking" {
  for_each = var.fleet_regions
  source   = "./modules/networking"

  project_name = var.project_name
  environment  = var.environment
  region       = each.key
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "valkey" {
  for_each = var.fleet_regions
  source   = "./modules/valkey"

  project_name   = var.project_name
  environment    = var.environment
  region         = each.key
  valkey_plan    = var.valkey_plan
  valkey_version = var.valkey_version
}

module "compute" {
  for_each = var.fleet_regions
  source   = "./modules/compute"

  project_name      = var.project_name
  environment       = var.environment
  region            = each.key
  instance_plan     = lookup(var.region_instance_plans, each.key, var.instance_plan)
  instance_count    = each.value
  firewall_group_id = module.networking[each.key].firewall_group_id
  vpc_ids           = [module.networking[each.key].vpc_id]
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
  sentry_dsn              = var.sentry_dsn
  mediasoup_num_workers   = var.mediasoup_num_workers

  redis_host     = module.valkey[each.key].host
  redis_port     = module.valkey[each.key].port
  redis_password = module.valkey[each.key].password

  broadcast_hls_enabled    = var.broadcast_hls_enabled
  hls_r2_endpoint          = var.hls_r2_endpoint
  hls_r2_bucket            = var.hls_r2_bucket
  hls_public_base_url      = var.hls_public_base_url
  hls_r2_access_key_id     = var.hls_r2_access_key_id
  hls_r2_secret_access_key = var.hls_r2_secret_access_key
}

module "loadbalancer" {
  for_each = var.fleet_regions
  source   = "./modules/loadbalancer"

  project_name = var.project_name
  environment  = var.environment
  region       = each.key
  app_port     = var.app_port
  instance_ids = module.compute[each.key].instance_ids
  vpc_id       = module.networking[each.key].vpc_id
  hostname     = local.region_hostnames[each.key]

  ssl_certificate = var.lb_ssl_certificate
  ssl_private_key = var.lb_ssl_private_key
  ssl_chain       = var.lb_ssl_chain

  allowed_sources = var.lb_allowed_sources
}

# --- State migration: un-keyed (slice D/E) -> keyed (slice 06) ----------------
# Terraform treats `module.compute` and `module.compute["bom"]` as DIFFERENT
# addresses. WITHOUT these `moved` blocks the first 3-region apply against the
# live single-region state would DESTROY the running tracer (deallocating its
# reserved IPs — the announced-IP Cloudflare DNS record breaks — and recreating
# its instances/LB). With them, the live region is re-homed to key
# `var.tracer_region` and only the two NEW regions plan as creates.
#
# The move key is HARDCODED "bom": `moved` blocks require a constant key (no
# variable/interpolation allowed), and bom is the region slices 04/05 applied
# (var.tracer_region's default, the live tracer 65.20.69.175). The compute
# module's OWN internal `main -> main[0]` moves still apply underneath these.
#
# NOTE: offline `terraform test` cannot verify state migration. The destroy-safety
# of the live reserved IP is a HITL pre-apply gate: `terraform plan` against the
# real HCP state MUST show 0 `vultr_reserved_ip` destroys before apply.
moved {
  from = module.networking
  to   = module.networking["bom"]
}

moved {
  from = module.valkey
  to   = module.valkey["bom"]
}

moved {
  from = module.compute
  to   = module.compute["bom"]
}

moved {
  from = module.loadbalancer
  to   = module.loadbalancer["bom"]
}
