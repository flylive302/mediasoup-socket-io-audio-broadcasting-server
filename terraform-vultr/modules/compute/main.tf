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

# State migration (slice D → E): the reserved IP + instance became `count`-indexed
# here. Terraform treats `main` and `main[0]` as DIFFERENT addresses, so WITHOUT
# these `moved` blocks the next apply against the live slice-D state would DESTROY
# the singletons and CREATE index 0 — deallocating reserved IP 65.20.69.175 (→ the
# slice-D Cloudflare DNS record breaks) and recreating the running instance. With
# them, scaling 1→2 plans as `0 destroyed, +1 reserved IP, +1 instance` (index 1
# only). Safe to keep permanently; harmless once state already uses the indexed form.
moved {
  from = vultr_reserved_ip.main
  to   = vultr_reserved_ip.main[0]
}

moved {
  from = vultr_instance.main
  to   = vultr_instance.main[0]
}

# One reserved IP PER fleet instance — each instance announces its OWN public IP
# (the announced-IP contract from slice D, now held across the whole fleet). count
# is the right shape for a homogeneous, manually-scaled fixed fleet: scaling is a
# tail-index add/remove, and the index-derived INSTANCE_ID_OVERRIDE below reuses
# names cleanly on scale-down/up.
resource "vultr_reserved_ip" "main" {
  count   = var.instance_count
  region  = var.region
  ip_type = "v4"
  label   = "${var.project_name}-${var.environment}-${var.region}-ip-${count.index + 1}"
}

resource "vultr_instance" "main" {
  count = var.instance_count

  region = var.region
  plan   = var.instance_plan
  os_id  = data.vultr_os.ubuntu.id
  # label/hostname are per-index (NOT a shared "-01"): if INSTANCE_ID_OVERRIDE ever
  # fails to render, instance-identity.ts falls back to os.hostname(), and a shared
  # hostname across the fleet would produce duplicate Redis CAS selfIds → audio
  # split-brain. The OS identity and the override agree at index n.
  label             = "${var.project_name}-${var.environment}-${var.region}-${format("%02d", count.index + 1)}"
  hostname          = "${var.project_name}-${var.environment}-${var.region}-${format("%02d", count.index + 1)}"
  tags              = [var.project_name, var.environment, var.region]
  firewall_group_id = var.firewall_group_id
  reserved_ip_id    = vultr_reserved_ip.main[count.index].id
  vpc_ids           = var.vpc_ids
  backups           = "disabled"

  # NOT base64encode()'d here — the Vultr provider base64-encodes user_data
  # itself before sending it to the API. Wrapping it ourselves double-encodes
  # it: cloud-init receives a base64 STRING instead of a script and silently
  # never executes anything (confirmed live: 0GB bandwidth, no
  # /var/log/user-data.log, docker never installed — see chat 2026-07-06).
  user_data = templatefile("${path.module}/templates/cloud-init.sh.tpl", {
    announced_ip = vultr_reserved_ip.main[count.index].subnet
    # Deterministic, unique-per-instance CAS selfId. instance-identity.ts reads
    # INSTANCE_ID_OVERRIDE FIRST (before the AWS-only IMDSv2 probe, which would
    # otherwise run-and-fail on every Vultr boot), so this both fixes uniqueness
    # and skips a doomed metadata call. Human-readable → AC#3 split-brain
    # ownership is verifiable in logs (`flylive-audio-bom-1` owns the room, not a
    # random container id).
    instance_id_override    = "${var.project_name}-${var.region}-${count.index + 1}"
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
# Slice 05: the contract now spans the WHOLE fleet — EVERY instance must announce
# a public IP, because each is independently reachable as a cascade origin/edge.
locals {
  public_ips = vultr_reserved_ip.main[*].subnet

  # Guarded per-IP octet parse: empty list when the string isn't a dotted quad
  # (mirrors slice D's `can(regex(...)) ? split : []` so empty/malformed IPs fail
  # the check cleanly instead of erroring on octet indexing). The regex guarantees
  # exactly four \d{1,3} groups, so a matched IP always yields 4 tonumber-able octets.
  ip_octets = [
    for ip in local.public_ips :
    can(regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$", ip)) ? [for o in split(".", ip) : tonumber(o)] : []
  ]

  # Per-instance is-public-IPv4 flag. `&&` short-circuits in Terraform, so the
  # `length(oct) == 4` guard prevents the private-range checks from indexing an
  # empty list (confirmed by slice D's empty_ip_rejected test passing cleanly).
  ip_public_flags = [
    for oct in local.ip_octets : (
      length(oct) == 4
      && alltrue([for o in oct : o >= 0 && o <= 255])
      && !(
        oct[0] == 0 ||
        oct[0] == 127 ||
        oct[0] == 10 ||
        (oct[0] == 172 && oct[1] >= 16 && oct[1] <= 31) ||
        (oct[0] == 192 && oct[1] == 168) ||
        (oct[0] == 169 && oct[1] == 254)
      )
    )
  ]

  # The fleet-wide contract: every instance announces a public IPv4.
  all_public_ipv4 = length(local.ip_public_flags) > 0 && alltrue(local.ip_public_flags)
}

# Belt-and-suspenders: the INSTANCE_ID_OVERRIDEs are unique BY CONSTRUCTION
# (index-derived), and so are the instance hostnames — but a duplicate selfId is
# the exact split-brain hazard instance-identity.ts warns about, so assert it at
# plan time rather than trust the construction silently.
check "instance_ids_distinct" {
  assert {
    condition     = length(distinct(vultr_instance.main[*].hostname)) == var.instance_count
    error_message = "Fleet instance hostnames are not all distinct — duplicate os.hostname() fallbacks would collide Redis CAS selfIds (audio split-brain)."
  }
}

