# =============================================================================
# Compute Module — Reserved IP + Instance + cloud-init bootstrap
# =============================================================================
# The announced IP is a `vultr_reserved_ip` created BEFORE the instance and
# attached via `reserved_ip_id` — its `subnet` attribute is a real Terraform-
# known value (available at plan time as "(known after apply)" only on first
# create, but never fetched from an in-instance metadata call). This is the
# load-bearing contract from 04-single-region-vultr-tracer.md: cascade
# edge<->origin pipes and client media both depend on this being a real,
# reachable public address, never empty/private/loopback.
# =============================================================================

terraform {
  required_providers {
    vultr = {
      source = "vultr/vultr"
    }
  }
}

data "vultr_os" "ubuntu" {
  filter {
    name   = "name"
    values = ["Ubuntu 24.04 LTS x64"]
  }
}

resource "vultr_reserved_ip" "main" {
  region  = var.region
  ip_type = "v4"
  label   = "${var.project_name}-${var.environment}-${var.region}-ip"
}

resource "vultr_instance" "main" {
  region            = var.region
  plan              = var.instance_plan
  os_id             = data.vultr_os.ubuntu.id
  label             = "${var.project_name}-${var.environment}-${var.region}-01"
  hostname          = "${var.project_name}-${var.environment}-${var.region}-01"
  tags              = [var.project_name, var.environment, var.region]
  firewall_group_id = var.firewall_group_id
  reserved_ip_id    = vultr_reserved_ip.main.id
  vpc_ids           = var.vpc_ids
  backups           = "disabled"

  # NOT base64encode()'d here — the Vultr provider base64-encodes user_data
  # itself before sending it to the API. Wrapping it ourselves double-encodes
  # it: cloud-init receives a base64 STRING instead of a script and silently
  # never executes anything (confirmed live: 0GB bandwidth, no
  # /var/log/user-data.log, docker never installed — see chat 2026-07-06).
  user_data = templatefile("${path.module}/templates/cloud-init.sh.tpl", {
    announced_ip            = vultr_reserved_ip.main.subnet
    app_port                = var.app_port
    rtc_min_port            = var.rtc_min_port
    rtc_max_port            = var.rtc_max_port
    image_ref               = "${var.ghcr_image}:${var.image_tag}"
    ghcr_pull_token         = var.ghcr_pull_token
    laravel_internal_key    = var.laravel_internal_key
    jwt_secret              = var.jwt_secret
    jwt_max_age_seconds     = var.jwt_max_age_seconds
    session_secret          = var.session_secret
    laravel_api_url         = var.laravel_api_url
    laravel_api_timeout_ms  = var.laravel_api_timeout_ms
    cors_origins            = var.cors_origins
    ice_stun_urls           = var.ice_stun_urls
    cloudflare_turn_api_key = var.cloudflare_turn_api_key
    cloudflare_turn_key_id  = var.cloudflare_turn_key_id
    cascade_enabled         = var.cascade_enabled
    mediasoup_num_workers   = var.mediasoup_num_workers
    redis_host              = var.redis_host
    redis_port              = var.redis_port
    redis_password          = var.redis_password

    broadcast_hls_enabled    = var.broadcast_hls_enabled
    hls_r2_endpoint          = var.hls_r2_endpoint
    hls_r2_bucket            = var.hls_r2_bucket
    hls_public_base_url      = var.hls_public_base_url
    hls_r2_access_key_id     = var.hls_r2_access_key_id
    hls_r2_secret_access_key = var.hls_r2_secret_access_key
  })
}

# --- Public-IP contract (the required smoke check, enforced on every plan/apply) ---
# Validates the CONTRACT (a real, public, reachable IPv4), not shell mechanics —
# this is a Terraform-level guard that runs before cloud-init ever executes.
locals {
  public_ip          = vultr_reserved_ip.main.subnet
  ipv4_octet_strings = can(regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$", local.public_ip)) ? split(".", local.public_ip) : []
  ipv4_octets        = [for o in local.ipv4_octet_strings : tonumber(o)]
  is_well_formed     = length(local.ipv4_octets) == 4 && alltrue([for o in local.ipv4_octets : o >= 0 && o <= 255])
  is_private_or_reserved = local.is_well_formed && (
    local.ipv4_octets[0] == 0 ||
    local.ipv4_octets[0] == 127 ||
    local.ipv4_octets[0] == 10 ||
    (local.ipv4_octets[0] == 172 && local.ipv4_octets[1] >= 16 && local.ipv4_octets[1] <= 31) ||
    (local.ipv4_octets[0] == 192 && local.ipv4_octets[1] == 168) ||
    (local.ipv4_octets[0] == 169 && local.ipv4_octets[1] == 254)
  )
  is_public_ipv4 = local.is_well_formed && !local.is_private_or_reserved
}

