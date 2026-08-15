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

  laravel_internal_key = var.laravel_internal_key
  jwt_secret           = var.jwt_secret

  # Rotation overlap — empty outside a rotation, so this is inert by default.
  laravel_internal_key_previous = var.laravel_internal_key_previous
  jwt_secret_previous           = var.jwt_secret_previous
  internal_api_key_previous     = var.internal_api_key_previous

  session_secret          = var.session_secret
  laravel_api_url         = var.laravel_api_url
  cors_origins            = var.cors_origins
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  cloudflare_turn_key_id  = var.cloudflare_turn_key_id
  sentry_dsn              = var.sentry_dsn
  mediasoup_num_workers   = var.mediasoup_num_workers
  cascade_enabled         = var.cascade_enabled
  affinity_enabled        = var.affinity_enabled

  redis_host     = module.valkey[each.key].host
  redis_port     = module.valkey[each.key].port
  redis_password = module.valkey[each.key].password

  # Per-instance TLS termination (issue 36) — reuses the SAME Cloudflare
  # Origin CA material as the regional LB (var.lb_ssl_*). Confirmed live
  # 2026-08-16 against prod.tfvars: the existing cert's SAN already covers
  # `*.audio.flyliveapp.com`, the exact label depth issue 16's per-instance
  # hostnames sit at — no second cert to issue.
  ssl_certificate = var.lb_ssl_certificate
  ssl_private_key = var.lb_ssl_private_key
  ssl_chain       = var.lb_ssl_chain

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

# --- Per-instance DNS (issue 16) ---------------------------------------------
# One Cloudflare A record per fleet instance, name derived from the SAME
# hostname main.tf already renders for the instance (modules/compute/main.tf:
# "${project_name}-${environment}-${region}-NN", also the INSTANCE_ID_OVERRIDE
# basis) — no new identifier. Flattened across every region so scaling
# fleet_regions (or adding a region) grows/shrinks records automatically; no
# separate DNS step. Gated by var.manage_instance_dns (default false, see
# variables.tf) — for_each on an empty map when unset, so this is a genuine
# no-op until an operator deliberately flips it, per the ship-inert rule.
#
# 🔴 KNOWN GAP (see README.md § Per-instance DNS before flipping the gate):
# the instance's app container serves plain HTTP/WS on var.app_port — TLS is
# ONLY terminated by the regional load balancer (modules/loadbalancer, Cloudflare
# Origin CA on :443). A proxied record pointing straight at an instance's
# reserved IP has nothing trusted to complete a Full(strict) handshake against
# today. This resource is the DNS half only; per-instance TLS termination is
# not in scope here and must land before `manage_instance_dns = true` is safe.
locals {
  instance_dns_records = var.manage_instance_dns ? merge([
    for r, m in module.compute : {
      for idx, hostname in m.instance_hostnames :
      "${r}-${idx}" => {
        hostname = hostname
        ip       = m.public_ips[idx]
      }
    }
  ]...) : {}
}

resource "cloudflare_dns_record" "instance" {
  for_each = local.instance_dns_records

  zone_id = var.cloudflare_zone_id
  name    = "${each.value.hostname}.${var.audio_domain}"
  type    = "A"
  content = each.value.ip
  proxied = true
  ttl     = 1 # Cloudflare requires ttl=1 ("Auto") on proxied records.
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
