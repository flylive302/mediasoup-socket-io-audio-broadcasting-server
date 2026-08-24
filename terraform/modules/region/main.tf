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
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

module "networking" {
  source = "../networking"

  project_name       = var.project_name
  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  app_port           = var.app_port
  rtc_min_port       = var.rtc_min_port
  rtc_max_port       = var.rtc_max_port
  cascade_ports_open = var.cascade_ports_open

  # aws-production/08 — see modules/networking/variables.tf for why this is
  # two variables instead of one.
  loadgen_ingress_enabled   = var.loadgen_ingress_enabled
  loadgen_security_group_id = var.loadgen_security_group_id

  # ticket 39 — same gate as the per-instance DNS record + SSM token below.
  manage_instance_dns = var.manage_instance_dns
}

# CACHE store (aws-platform-build/21): evict-freely, no backups — rate limits,
# presence, socket mappings, socket.io pub/sub. Keeps the original "-redis"
# resource names.
module "redis" {
  source = "../redis"

  project_name            = var.project_name
  environment             = var.environment
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking.private_subnet_ids
  redis_security_group_id = module.networking.redis_security_group_id
  redis_auth_token        = var.redis_auth_token

  # Sizing/HA profile (aws-production/01) — defaults reproduce the old literals.
  num_cache_clusters         = var.redis_num_cache_clusters
  automatic_failover_enabled = var.redis_automatic_failover
  multi_az_enabled           = var.redis_multi_az
}

# DURABLE store (aws-platform-build/21): noeviction + automated snapshots —
# in-flight money queue (gifts:pending), room/seat/block state, CAS ownership,
# revocation, dedup/ordering. Separate replication group because a per-key
# memory ceiling is not expressible inside one group (ticket 21 decision).
module "redis_durable" {
  source = "../redis"

  project_name             = var.project_name
  environment              = var.environment
  name_suffix              = "-durable"
  redis_node_type          = coalesce(var.redis_durable_node_type, var.redis_node_type)
  private_subnet_ids       = module.networking.private_subnet_ids
  redis_security_group_id  = module.networking.redis_security_group_id
  redis_auth_token         = var.redis_auth_token
  maxmemory_policy         = "noeviction"
  snapshot_retention_limit = var.redis_durable_snapshot_retention_days
  snapshot_window          = var.redis_durable_snapshot_window

  # Sizing/HA profile (aws-production/01). The durable store sizes independently
  # of the cache store; null falls back to whatever the cache store runs.
  # (Explicit null checks, not coalesce: coalesce treats an empty string as
  # absent, which makes it the wrong tool for a bool that may legitimately be
  # false.)
  num_cache_clusters         = var.redis_durable_num_cache_clusters != null ? var.redis_durable_num_cache_clusters : var.redis_num_cache_clusters
  automatic_failover_enabled = var.redis_durable_automatic_failover != null ? var.redis_durable_automatic_failover : var.redis_automatic_failover
  multi_az_enabled           = var.redis_durable_multi_az != null ? var.redis_durable_multi_az : var.redis_multi_az
}

module "ssl" {
  source    = "../ssl"
  providers = { aws = aws, cloudflare = cloudflare }

  project_name         = var.project_name
  environment          = var.environment
  audio_domain         = var.audio_domain
  cloudflare_zone_id   = var.cloudflare_zone_id
  caa_records_override = var.caa_records_override
}

module "loadbalancer" {
  source = "../loadbalancer"

  project_name      = var.project_name
  environment       = var.environment
  vpc_id            = module.networking.vpc_id
  public_subnet_ids = module.networking.public_subnet_ids
  app_port          = var.app_port
  certificate_arn   = module.ssl.certificate_arn
  # Registration is ASG-managed (ticket 23) — the module has no per-instance
  # attachment surface at all; the ASG's target_group_arns does the work.
}

# Base audio hostname → NLB. PROXIED (orange cloud) — changed 2026-08-17,
# ticket 28. This record's proxy mode is a cutover-safety decision, not a
# routing preference; do not "simplify" it back to DNS-only without reading
# docs/runbooks/msab-aws-cutover.md §4a.
#
# Why proxied, when the previous comment here said "never proxied":
#
#   audio.flyliveapp.com is proxied TODAY (measured 2026-08-17: it resolves to
#   104.21.8.242 / 172.67.188.214 — Cloudflare anycast — at TTL 300, which
#   Cloudflare pins and which therefore cannot be lowered ahead of a flip).
#   Publishing a DNS-only record here would change the PUBLIC answer from
#   Cloudflare's anycast IPs to the NLB hostname, so every resolver holding the
#   old answer keeps dialling Cloudflare's edge for a hostname Cloudflare no
#   longer proxies — a hard error, for up to 300s, with no way to pre-shorten
#   it. Keeping the record proxied changes only the ORIGIN behind an unchanged
#   public answer: the flip takes effect at Cloudflare's edge immediately, and
#   the rollback (repoint the origin back to bom-02) is exactly as immediate
#   and exactly as symmetric.
#
#   The old rationale — "the NLB terminates TLS with the ACM cert, and
#   WebRTC/socket traffic is not Cloudflare-HTTP" — does not actually argue for
#   DNS-only. WebRTC media never touches this record (it goes direct to
#   instance IPs on the RTC port range); what rides this hostname is Socket.IO
#   signalling, which is HTTP/WS and already proxies through Cloudflare on the
#   live Vultr stack today. Cloudflare validates the ACM cert on the origin leg
#   under Full (Strict); the NLB's only public entry is the TLS listener on 443
#   (modules/loadbalancer/main.tf), which is what Cloudflare dials.
#
# ttl = 1 is REQUIRED, not a choice: the Cloudflare API rejects any other TTL
# on a proxied record ("automatic"). The 60 that used to be here was only
# reachable because the record was DNS-only.
#
# Per-instance hostnames are a separate surface (aws-production ticket 16) and
# are NOT covered by this decision — see the runbook's console table for the
# open Origin-CA/browser-trust question on those.
#
# ⛔ Gated (manage_audio_dns): in production audio.flyliveapp.com is a LIVE
# A-record to Vultr until the ticket-28 cutover — creating this CNAME before
# then IS the DNS flip. Staging keeps it on (its hostname serves nothing yet).
resource "cloudflare_dns_record" "audio" {
  count   = var.manage_audio_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.audio_domain
  type    = "CNAME"
  content = module.loadbalancer.nlb_dns_name
  proxied = true
  ttl     = 1
}

# Secrets replicated into this region's SSM (SSM Parameter Store is regional —
# without this, instances boot with empty secrets: Redis AUTH fails → 503 loop).
module "ssm" {
  source = "../ssm"

  project_name            = var.project_name
  environment             = var.environment
  jwt_secret              = var.jwt_secret
  jwt_secret_previous     = var.jwt_secret_previous
  laravel_internal_key    = var.laravel_internal_key
  session_secret          = var.session_secret
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  redis_auth_token        = var.redis_auth_token

  broadcast_hls_enabled    = var.broadcast_hls_enabled
  hls_r2_access_key_id     = var.hls_r2_access_key_id
  hls_r2_secret_access_key = var.hls_r2_secret_access_key

  # ticket 39 — per-instance DNS + TLS. All three are only ever WRITTEN to SSM
  # (and only when manage_instance_dns / a non-empty cert is actually set); see
  # modules/ssm/main.tf for the exact gating conditions.
  manage_instance_dns      = var.manage_instance_dns
  cloudflare_api_token     = var.cloudflare_api_token
  instance_tls_certificate = var.instance_tls_certificate
  instance_tls_private_key = var.instance_tls_private_key
  instance_tls_chain       = var.instance_tls_chain

  iam_role_name = var.iam_role_name
  aws_region    = var.aws_region
}

# Ticket 32 PART 4: workers_below_expected's threshold is DERIVED, not
# hardcoded — fleet_size × modules/autoscaling's own workers_per_instance
# output (vCPU - 1 per instance, mirroring MSAB's boot-time derivation,
# ticket 24). Forward-referencing module.autoscaling here (declared below) is
# fine: Terraform resolves dependencies from the reference graph, not file
# order, and nothing in modules/autoscaling depends on modules/cloudwatch, so
# this creates no cycle.
locals {
  expected_total_workers = var.fleet_size * module.autoscaling.workers_per_instance
}

module "cloudwatch" {
  source = "../cloudwatch"

  project_name           = var.project_name
  environment            = var.environment
  aws_region             = var.aws_region
  alerts_topic_arn       = var.alerts_topic_arn
  expected_total_workers = local.expected_total_workers
}

module "autoscaling" {
  source = "../autoscaling"

  region                 = var.aws_region
  project_name           = var.project_name
  environment            = var.environment
  instance_type          = var.instance_type
  instance_architecture  = var.instance_architecture
  ssh_public_key_path    = var.ssh_public_key_path
  instance_profile_name  = var.instance_profile_name
  msab_security_group_id = module.networking.msab_security_group_id
  public_subnet_ids      = module.networking.public_subnet_ids
  target_group_arn       = module.loadbalancer.target_group_arn
  ecr_repo_url           = var.ecr_repo_url
  image_tag              = var.image_tag
  app_port               = var.app_port
  rtc_min_port           = var.rtc_min_port
  rtc_max_port           = var.rtc_max_port
  # REDIS_* = durable store; REDIS_CACHE_* = evict-freely store (ticket 21).
  redis_host       = module.redis_durable.redis_host
  redis_port       = module.redis_durable.redis_port
  redis_cache_host = module.redis.redis_host
  redis_cache_port = module.redis.redis_port
  # NOTE: laravel_internal_key / jwt_secret / session_secret / audio_domain /
  # cloudflare_turn_api_key are NOT passed to autoscaling any more (ticket 18) — the
  # module never used them; the instance fetches those secrets from SSM at boot.
  cors_origins           = var.cors_origins
  laravel_api_url        = var.laravel_api_url
  cascade_enabled        = var.cascade_enabled
  cloudflare_turn_key_id = var.cloudflare_turn_key_id
  event_queue_url        = var.event_queue_url
  sentry_dsn             = var.sentry_dsn

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

  # ticket 39 — per-instance DNS. Non-sensitive: hostname suffix + zone id only;
  # the actual Cloudflare API token is fetched at boot from SSM (never passed
  # here). false/"" (defaults) render NO dns code at all — see user-data.sh.
  manage_instance_dns = var.manage_instance_dns
  audio_domain        = var.audio_domain
  cloudflare_zone_id  = var.cloudflare_zone_id

  # Fixed-size fleet: ONE number drives min = max = desired (ticket 18 AC #2).
  fleet_size = var.fleet_size

  # Zero Healthy Hosts alarm dimensions
  target_group_arn_suffix      = module.loadbalancer.target_group_arn_suffix
  load_balancer_arn_suffix     = module.loadbalancer.nlb_arn_suffix
  alarm_notification_topic_arn = var.alerts_topic_arn
}
