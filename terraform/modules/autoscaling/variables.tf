# Auto Scaling Module — Variables

variable "region" {
  description = "AWS region identifier (e.g., ap-south-1) — passed to MSAB for cross-region routing"
  type        = string
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type (CPU-optimized recommended for MediaSoup)"
  type        = string
  default     = "c7i.xlarge"

  # ticket 18: the container memory cap is COMPUTED from this type's RAM
  # (var.instance_memory_mib), so an unknown type must fail at plan, not silently
  # render a wrong --memory. Add the type to instance_memory_mib to allow it.
  validation {
    condition     = contains(keys(var.instance_memory_mib), var.instance_type)
    error_message = "instance_type must be a key of var.instance_memory_mib — the container memory cap is derived from its RAM. Add the type (with its real RAM in MiB) to that map first."
  }
}

variable "instance_memory_mib" {
  description = <<-EOT
    instance_type → physical RAM in MiB, from the AWS EC2 instance-type spec sheet.
    This is the ONLY place a RAM figure appears: the container's --memory cap is
    computed as (this value − host_reserve_gib), never restated as a literal
    (ticket 18). Extend the map when a new instance type is introduced.
  EOT
  type        = map(number)
  default = {
    # c7i (Intel, amd64) — the default family
    "c7i.large"    = 4096
    "c7i.xlarge"   = 8192
    "c7i.2xlarge"  = 16384
    "c7i.4xlarge"  = 32768
    "c7i.8xlarge"  = 65536
    "c7i.12xlarge" = 98304
    # c7g / c8g (Graviton, arm64) — same 2 GiB-per-vCPU ratio
    "c7g.large"   = 4096
    "c7g.xlarge"  = 8192
    "c7g.2xlarge" = 16384
    "c7g.4xlarge" = 32768
    "c8g.large"   = 4096
    "c8g.xlarge"  = 8192
    "c8g.2xlarge" = 16384
    "c8g.4xlarge" = 32768
  }
}

variable "instance_vcpu" {
  description = <<-EOT
    instance_type → vCPU count, from the AWS EC2 instance-type spec sheet (the same
    sheet instance_memory_mib cites). Kept as its OWN explicit map — deliberately NOT
    inferred from instance_memory_mib / 2048, even though every entry below happens to
    hold that 2 GiB-per-vCPU ratio today. Inferring it would silently mis-derive
    workers_per_instance (ticket 32 PART 4 — feeds modules/cloudwatch's
    workers_below_expected alarm threshold) the day someone adds an instance type whose
    RAM:vCPU ratio differs, with no plan-time error — just a threshold that's quietly
    wrong forever. The validation below forces every instance_memory_mib entry to have
    a matching instance_vcpu entry, so adding a type means stating BOTH numbers or
    failing at plan.
  EOT
  type        = map(number)
  default = {
    # c7i (Intel, amd64)
    "c7i.large"    = 2
    "c7i.xlarge"   = 4
    "c7i.2xlarge"  = 8
    "c7i.4xlarge"  = 16
    "c7i.8xlarge"  = 32
    "c7i.12xlarge" = 48
    # c7g / c8g (Graviton, arm64)
    "c7g.large"   = 2
    "c7g.xlarge"  = 4
    "c7g.2xlarge" = 8
    "c7g.4xlarge" = 16
    "c8g.large"   = 2
    "c8g.xlarge"  = 4
    "c8g.2xlarge" = 8
    "c8g.4xlarge" = 16
  }

  validation {
    condition     = length(setsubtract(keys(var.instance_memory_mib), keys(var.instance_vcpu))) == 0 && length(setsubtract(keys(var.instance_vcpu), keys(var.instance_memory_mib))) == 0
    error_message = "instance_vcpu and instance_memory_mib must declare exactly the same set of instance_type keys — every type needs both its RAM and its vCPU count stated explicitly, not inferred from one another."
  }
}

variable "host_reserve_gib" {
  description = <<-EOT
    RAM (GiB) left to the host OS + Docker daemon, subtracted from the instance's RAM
    to get the container's --memory cap. 2 GiB reproduces the proven production runtime
    exactly: 8 GiB (c7i.xlarge / the live vhf-3c-8gb box) − 2 = 6g, which is what
    `docs/runbooks/msab-by-hand-deploy.md` runs today.

    ⚠️ The reserve is NOT a fixed fraction — the runbook's (never-deployed) 16 GiB variant
    used 13g, i.e. a 3 GiB reserve. 2 GiB is correct for the sizes in use now; re-pick it
    alongside ticket 35's final sizing if the instance type changes.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.host_reserve_gib >= 1
    error_message = "host_reserve_gib must leave at least 1 GiB to the host."
  }

  # The reserve is subtracted from the instance's RAM. Without a floor, a large reserve on a
  # small instance renders `--memory=0m` — which Docker may read as "no limit", silently
  # removing the cap instead of failing loudly. lookup()'s sentinel keeps an unknown
  # instance_type from raising a SECOND error here (it has its own validation).
  validation {
    condition     = lookup(var.instance_memory_mib, var.instance_type, 999999) - (var.host_reserve_gib * 1024) >= 2048
    error_message = "host_reserve_gib leaves the container under 2 GiB on this instance_type. Pick a bigger instance type or a smaller reserve — a near-zero cap is worse than no cap."
  }
}

variable "instance_architecture" {
  description = <<-EOT
    CPU architecture for the AMI + container image: "amd64" (x86_64, default) or "arm64" (Graviton).
    Must match the instance_type family: c7i/c7g pairs vs c8g (arm64). The default keeps the exact
    amd64 Ubuntu AMI used historically — do NOT flip to arm64 in prod until a multi-arch MSAB image
    is published and validated on staging (realtime-06 HITL gate).
  EOT
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["amd64", "arm64"], var.instance_architecture)
    error_message = "instance_architecture must be \"amd64\" or \"arm64\"."
  }
}

variable "ssh_public_key_path" {
  description = "Path to SSH public key for EC2 access"
  type        = string
}

variable "instance_profile_name" {
  description = "IAM instance profile name for EC2 instances"
  type        = string
}

variable "msab_security_group_id" {
  description = "Security group ID for MSAB instances"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ASG placement"
  type        = list(string)
}

variable "target_group_arn" {
  description = "NLB target group ARN for instance registration"
  type        = string
}

# --- App Configuration ---

variable "ecr_repo_url" {
  description = "ECR repository URL for the MSAB Docker image"
  type        = string
}

variable "app_port" {
  description = "Application HTTP/WebSocket port"
  type        = number
  default     = 3030
}

variable "rtc_min_port" {
  description = "Minimum WebRTC UDP port"
  type        = number
  default     = 10000
}

variable "rtc_max_port" {
  description = "Maximum WebRTC UDP port"
  type        = number
  default     = 59999
}

variable "redis_host" {
  description = "Redis/ElastiCache host"
  type        = string
}

variable "redis_port" {
  description = "Redis port"
  type        = number
  default     = 6379
}

variable "redis_cache_host" {
  description = "Cache-store ElastiCache host (evict-freely; rate limits, presence, socket.io pub/sub). The redis_host above is the DURABLE store."
  type        = string
}

variable "redis_cache_port" {
  description = "Cache-store Redis port"
  type        = number
  default     = 6379
}

# NOTE (ticket 18): laravel_internal_key, jwt_secret, session_secret, audio_domain and
# cloudflare_turn_api_key used to be declared here and passed into templatefile(), but
# user-data.sh never referenced their placeholders — every one of those secrets is fetched
# at boot from SSM instead (ticket 16). They were dead plumbing and are gone. The root/region
# modules still declare them; the SSM module is their real consumer.

variable "cors_origins" {
  description = "CORS origins for the app"
  type        = string
  default     = "https://flyliveapp.com,https://app.flyliveapp.com"
}

variable "laravel_api_url" {
  description = "Laravel API base URL"
  type        = string
  default     = "https://app.flyliveapp.com"
}

variable "event_queue_url" {
  description = <<-EOT
    URL of the msab-events FIFO queue (module.queues) the SQS consumer polls.
    Empty (the default) renders NO EVENT_QUEUE_URL line into the instance env,
    which is the consumer's inert state — ships-inert by default, per the same
    rule as every other transport switch in this stack. Passed as a terraform
    OUTPUT from the queues module, never as a tfvars literal.
  EOT
  type        = string
  default     = ""
}

variable "sentry_dsn" {
  description = <<-EOT
    Sentry DSN for MSAB error reporting (env-diff finding 2026-08-18: the Vultr
    fleet reported to Sentry, the AWS fleet did not). Empty (the default)
    renders NO SENTRY_* lines into the instance env — Sentry stays off. When
    set, SENTRY_RELEASE is var.image_tag (must be the byte-identical
    sha-<commit8> the image's sourcemaps were uploaded under, which image_tag
    already is by construction) and SENTRY_ENVIRONMENT is var.environment.
  EOT
  type        = string
  default     = ""
}

# --- Scaling Configuration ---

variable "fleet_size" {
  description = <<-EOT
    Number of MSAB instances in this region's ASG. ONE variable on purpose: it is wired to
    min_size, max_size AND desired_capacity, so a fixed-size fleet is structurally guaranteed
    rather than a convention three independent numbers happen to honour (ticket 18 AC #2;
    the fixed-size decision itself is ticket 06).

    ⚠️ Quota truth (carried over from the old max_instances): fleet_size × instance vCPU must
    fit the account's On-Demand Standard vCPU quota (L-1216C47A) IN THIS REGION. With the
    default 16-vCPU quota and c7i.xlarge (4 vCPU) the real ceiling is 4 instances. Ticket 02's
    increase is filed but NOT yet granted — keep this truthful to the quota actually in force.
    Ticket 35 supplies the final number from the load test; 2 is the honest carry-over default.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.fleet_size >= 1
    error_message = "fleet_size must be at least 1 — a 0-instance ASG is a total audio outage."
  }
}

variable "connections_alarm_high_threshold" {
  description = "ActiveConnections level above which the visibility-only high-connections alarm fires. Named for the alarm, not for scaling — no scaling policy exists (ticket 18 AC #5)."
  type        = number
  default     = 500
}

variable "connections_alarm_low_threshold" {
  description = "ActiveConnections level below which the visibility-only low-connections alarm fires. Named for the alarm, not for scaling — no scaling policy exists (ticket 18 AC #5)."
  type        = number
  default     = 100
}

# --- Drain window (ticket 18 AC #3) --------------------------------------------------
# THE single source of truth for every drain-related timeout is app_drain_ceiling_seconds.
# The terminate hook, the on-instance drain script's poll ceiling, and the timeout the
# script ASKS the app for are all derived from it in locals (main.tf) — none of them is a
# free-standing literal, so they cannot drift apart again.
#
# History of the drift this kills: the hook went 900s → 150s but the script's own
# MAX_DRAIN_WAIT literal stayed at 900s and asked the app for 900−60 = 840s, i.e. the script
# polled for 900s inside a window AWS closed at 150s. Naively carrying the −60 offset onto
# the 150s window would have asked for 90s — BELOW the app's own 120s ceiling — a quieter
# version of the same bug. Hence: derive from the app's ceiling, never from the hook.

variable "app_drain_ceiling_seconds" {
  description = <<-EOT
    MSAB's own SIGTERM drain ceiling, in seconds. MUST mirror DRAIN_CEILING_MS in
    `src/index.ts` (120_000 ms — F-5). This is the ONE value every other drain timeout is
    derived from; changing it here without changing the app is the drift this variable exists
    to prevent, so the app carries a comment pointing back at this variable.
  EOT
  type        = number
  default     = 120
}

variable "drain_hook_margin_seconds" {
  description = <<-EOT
    Seconds added to app_drain_ceiling_seconds to size the ASG terminate-hook heartbeat.
    30s matches the app's own hard-kill margin (`src/index.ts`: DRAIN_CEILING_MS + 30_000),
    so AWS holds the instance for exactly as long as the process can still be alive.
    Total heartbeat = 120 + 30 = 150s.
  EOT
  type        = number
  default     = 30

  # The margin must cover everything that happens INSIDE the hook window but OUTSIDE the app's
  # drain: the lifecycle-state detection lag (up to one lifecycle_poll_interval_seconds — the
  # hook's clock starts when AWS transitions the instance, not when the script notices) plus one
  # drain poll tick. A margin at or below that reintroduces the unrecoverable race this ticket
  # exists to kill: complete-lifecycle-action losing to hook expiry, with no heartbeat ever sent.
  validation {
    condition     = var.drain_hook_margin_seconds > var.lifecycle_poll_interval_seconds + var.drain_poll_interval_seconds
    error_message = "drain_hook_margin_seconds must EXCEED lifecycle_poll_interval_seconds + drain_poll_interval_seconds — otherwise the detection lag alone can consume the whole margin."
  }
}

variable "lifecycle_poll_interval_seconds" {
  description = <<-EOT
    How often the on-instance drain monitor asks AWS whether this instance has entered
    Terminating:Wait. This is DETECTION LAG, and it is charged against the terminate hook's
    heartbeat just like the drain is — the hook's clock starts when AWS transitions the
    instance, not when the script notices. drain_hook_margin_seconds is validated against it.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.lifecycle_poll_interval_seconds >= 1
    error_message = "lifecycle_poll_interval_seconds must be at least 1."
  }
}

variable "drain_poll_interval_seconds" {
  description = <<-EOT
    How often the on-instance drain script polls MSAB's drain status. Also sets the script's
    give-up ceiling: app_drain_ceiling + one poll interval, so the script gives up exactly one
    tick after the app's own deadline — strictly INSIDE the hook window, never at the same
    instant AWS closes it (which would race complete-lifecycle-action against hook expiry).
  EOT
  type        = number
  default     = 5

  validation {
    condition     = var.drain_poll_interval_seconds >= 1
    error_message = "drain_poll_interval_seconds must be at least 1."
  }
}

# --- Cold-boot / warmup budget (ticket 18 AC #4) ---------------------------------------

variable "container_warmup_seconds" {
  description = <<-EOT
    Time from `docker run` to a 200 on /health, for the hardened image. MEASURED in ticket 17:
    1.9s observed run→healthy locally, budgeted at 90s to absorb the ECR pull and a cold page
    cache. Container-level ONLY — the bootstrap steps before it are budgeted separately in
    bootstrap_overhead_seconds.

    Also rendered into user-data as HEALTH_MAX_WAIT (aws-production 02 / F6): the bootstrap's
    /health release gate polls for exactly this long before failing closed, so the health
    ceiling, the ELB grace period and the launch-hook heartbeat all move together.
  EOT
  type        = number
  default     = 90
}

variable "launch_hook_margin_seconds" {
  description = <<-EOT
    Seconds added on top of the worst-case boot-to-health budget
    (bootstrap_overhead_seconds + container_warmup_seconds) to size the LAUNCH lifecycle
    hook's heartbeat (aws-production 02). The hook now completes strictly after the /health
    gate, so its heartbeat must exceed everything that can legitimately happen first; the
    margin absorbs estimate error in the PROVISIONAL bootstrap overhead itemisation.
    Default: 260 + 90 + 250 = 600s — reproducing the proven 600s literal it replaces.
  EOT
  type        = number
  default     = 250

  # The bootstrap overhead is an itemised ESTIMATE, not a measurement (its own description
  # says so). A thin margin turns any estimate error into an ABANDON-loop: every boot times
  # out mid-bootstrap, the ASG replaces the instance, forever — a total-outage class at
  # fleet_size=1. 60s ≈ the largest single line item in the itemisation.
  validation {
    condition     = var.launch_hook_margin_seconds >= 60
    error_message = "launch_hook_margin_seconds must be at least 60 — the bootstrap overhead is a provisional estimate, and a thin margin turns estimate error into a boot→ABANDON→replace loop."
  }
}

variable "bootstrap_overhead_seconds" {
  description = <<-EOT
    Everything user-data.sh does BEFORE the container can serve traffic. Itemised estimate,
    not a measurement. Re-derived by ticket 19's bootstrap reorder: the CloudWatch agent,
    the drain-service install (incl. its 3s liveness assert) and the launch-hook completion
    now ALL run before `docker run` — nothing user-data does happens after the container:

      apt-get update + upgrade ............  60
      Docker install (get.docker.com) .....  45
      AWS CLI v2 download + install .......  15
      iptables-persistent .................  10
      ECR login + pull (1.39 GiB image) ...  90
      7 serial SSM get-parameter calls ....  10
      CloudWatch agent download + dpkg ....  20
      drain service install + assert ......   5
      launch lifecycle-hook completion ....   5
                                            ---
                                            260

    ⚠️ PROVISIONAL. Re-check against the first real instance launch (/var/log/user-data.log
    is timestamped by cloud-init).
  EOT
  type        = number
  default     = 260
}

variable "canary_soak_seconds" {
  description = <<-EOT
    Ticket 29: how long the instance refresh pauses at each checkpoint — i.e. how long the
    canary instance serves real production traffic before the rollout continues. Must exceed
    the abort alarm's full detection window, or the soak could end before a sick canary can
    fire it: NLB flags a target unhealthy after unhealthy_threshold(3) × interval(30s) = 90s,
    then refresh_unhealthy_sustained needs 3 × 60s in that state = 270s worst-case
    detection. 300s default = 270s + margin. (The dormant deploy.yml soak was 180s — below
    the detection window; this replaces it, it does not merely port it.)
    Ordering asserted in tests/rollout.tftest.hcl.
  EOT
  type        = number
  default     = 300
}

variable "cascade_enabled" {
  description = "Enable SFU cross-region room cascading"
  type        = bool
  default     = true
}

variable "instance_type_overrides" {
  description = <<-EOT
    Ordered list of fallback instance types for the mixed-instances policy. When non-empty, the
    ASG tries each type in priority order until one has capacity. Empty (the default, and what
    root/region actually pass) uses only the primary instance_type from the launch template.

    ⚠️ Every override must have the SAME RAM as instance_type: the container's --memory cap is
    baked into user-data ONCE, from instance_type's RAM (ticket 18 AC #6). A fallback with less
    RAM would launch a container capped above the host's memory. Enforced below.
  EOT
  type        = list(string)
  default     = []

  validation {
    # lookup() with distinct sentinels: an unknown type can never compare equal, and an
    # unknown instance_type surfaces via its OWN validation rather than an index crash here.
    condition = alltrue([
      for t in var.instance_type_overrides :
      lookup(var.instance_memory_mib, t, -1) == lookup(var.instance_memory_mib, var.instance_type, -2)
    ])
    error_message = "Every instance_type_overrides entry must be a key of instance_memory_mib AND have the same RAM as instance_type — the container memory cap is rendered once, from instance_type."
  }
}

variable "cloudflare_turn_key_id" {
  description = "Cloudflare Realtime TURN key ID"
  type        = string
  default     = ""
}

# realtime-08: interactive↔broadcast flip thresholds (Listener count, hysteresis).
# Default 1500/1000; lower in tfvars to smoke-test the broadcast tier on a region.
variable "room_broadcast_threshold_up" {
  description = "Listener count at/above which a Room flips to broadcast mode"
  type        = number
  default     = 1500
}

variable "room_broadcast_threshold_down" {
  description = "Listener count at/below which a Room flips back to interactive mode"
  type        = number
  default     = 1000
}

# realtime-09: broadcast HLS tier. R2 access keys are SSM secrets (see iam module);
# these are the non-sensitive values templated into the container .env. Disabled by
# default — when true the MSAB config refine requires all HLS_R2_* + base URL set.
variable "broadcast_hls_enabled" {
  description = "Enable the LL-HLS broadcast publish tier (realtime-09)"
  type        = bool
  default     = false
}

variable "hls_r2_endpoint" {
  description = "R2 S3 API endpoint for HLS publishing, e.g. https://<acct>.r2.cloudflarestorage.com"
  type        = string
  default     = ""
}

variable "hls_r2_bucket" {
  description = "R2 bucket for live HLS artifacts (e.g. flylive-live-hls)"
  type        = string
  default     = ""
}

variable "hls_public_base_url" {
  description = "Public CDN base for HLS playback (no trailing slash), e.g. https://live.flyliveapp.com"
  type        = string
  default     = ""
}

variable "target_group_arn_suffix" {
  description = "ARN suffix of the NLB target group (for CloudWatch dimensions)"
  type        = string
  default     = ""
}

variable "load_balancer_arn_suffix" {
  description = "ARN suffix of the NLB (for CloudWatch dimensions)"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Pinned image tag (sha-<commit8> from the CI run that built it). Never \"latest\" — a cold-restore or instance replacement must always launch the exact staged/verified image."
  type        = string

  validation {
    condition     = var.image_tag != "" && var.image_tag != "latest"
    error_message = "image_tag must be a pinned sha-<commit8> tag, not empty or \"latest\"."
  }
}

variable "alarm_notification_topic_arn" {
  description = "SNS topic ARN for alarm notifications (zero healthy hosts, etc.)"
  type        = string
  default     = ""
}

# --- MSAB Application Config ---

variable "jwt_max_age_seconds" {
  description = "Maximum JWT age in seconds — written to boot .env"
  type        = number
  default     = 2592000 # 30 days
}

variable "laravel_api_timeout_ms" {
  description = "Timeout for MSAB → Laravel API calls in milliseconds"
  type        = number
  default     = 10000
}

variable "ice_stun_urls" {
  description = "Comma-separated STUN server URLs for WebRTC NAT traversal"
  type        = string
  default     = "stun:stun.cloudflare.com:3478,stun:stun.cloudflare.com:53"
}

# --- Per-instance DNS + TLS (ticket 39) ---

variable "manage_instance_dns" {
  description = <<-EOT
    Renders the per-instance DNS self-registration block into user-data.sh
    (`%%{ if manage_instance_dns ~}` — false means the DNS code does not even
    exist in the rendered script, not just that it's skipped at runtime).
    Default false. The TLS terminator is independently gated at RUNTIME by
    whether the tls-certificate/tls-private-key SSM parameters are actually
    set (fails OPEN), so it needs no separate terraform-level flag here.
  EOT
  type        = bool
  default     = false
}

variable "audio_domain" {
  description = "Base domain the per-instance DNS record is created under: `<ec2-instance-id>.audio_domain`. Only read when manage_instance_dns = true."
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id hosting audio_domain — used by the instance's own boot-time Cloudflare API calls (create) and terminate-time calls (delete). Only read when manage_instance_dns = true."
  type        = string
  default     = ""
}
