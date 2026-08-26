# =============================================================================
# Auto Scaling Module — Launch Template + fixed-size ASG + lifecycle hooks
# =============================================================================
#   - Launch Template (AMI, user-data, SG, IAM) — renders the container run
#   - Auto Scaling Group, FIXED SIZE (min = max = desired = var.fleet_size)
#   - Lifecycle hooks for graceful launch/terminate
#   - Visibility-only CloudWatch alarms (no alarm actions)
#
# ⛔ NO autoscaling policy ships here (ticket 18 AC #5). The fleet is fixed-size
#    per the epic-wide operator decision (ticket 06): mediasoup rooms are sticky
#    to an instance, so adding capacity does not relieve a hot instance, and
#    removing capacity drops live calls. Capacity is re-picked by hand from
#    ticket 35's saturation curve, not by a target-tracking policy.
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  # Ticket 31 / decision D3: every runtime resource NAME is qualified by the
  # environment so staging and production can coexist in AWS account
  # 505307260926 (ADR 0028). Deterministic from var.environment — full token,
  # no abbreviation map (all names verified inside AWS length limits).
  # TAGS keep using var.project_name; only NAMES take the prefix.
  env_prefix = "${var.project_name}-${var.environment}"

  # --- Container memory cap, COMPUTED (ticket 18 AC #6) ----------------------
  # No `7g`/`6g` literal exists anywhere: the cap is this instance type's RAM
  # minus a stated host reserve. c7i.xlarge (8192 MiB) − 2 GiB = 6144 MiB = the
  # exact 6g the proven production runtime uses today.
  instance_memory_mib  = var.instance_memory_mib[var.instance_type]
  container_memory_mib = local.instance_memory_mib - (var.host_reserve_gib * 1024)

  # --- Worker count, DERIVED (ticket 32 PART 4, mirroring ticket 24) --------
  # MSAB's own boot-time rule (user-data.sh comment, worker.manager.ts) is
  # vCPU - 1, one core reserved for the Node.js event loop. This mirrors that
  # rule in Terraform, from the explicit var.instance_vcpu map (NOT inferred
  # from RAM — see that variable's description), so modules/region can derive
  # modules/cloudwatch's workers_below_expected alarm threshold as
  # fleet_size × this value instead of a hand-maintained literal.
  instance_vcpu_count  = var.instance_vcpu[var.instance_type]
  workers_per_instance = local.instance_vcpu_count - 1

  # --- Drain window, DERIVED ONCE (ticket 18 AC #3) -------------------------
  # Single source of truth: var.app_drain_ceiling_seconds (mirrors the app's own
  # DRAIN_CEILING_MS). The three values below are the only consumers, and the
  # ordering they must satisfy is asserted in tests/drain_window.tftest.hcl:
  #
  #   drain_request  == app ceiling      (120) — never ask the app for LESS than it needs
  #   drain_poll_ceiling > app ceiling   (125) — one poll tick of slack past the app's deadline
  #   drain_poll_ceiling <  hook heartbeat (150) — the script finishes INSIDE the AWS window,
  #                                                so complete-lifecycle-action never races
  #                                                hook expiry (the script never sends a
  #                                                lifecycle heartbeat, so there is no slack
  #                                                to be had after the fact)
  drain_request_seconds      = var.app_drain_ceiling_seconds
  drain_poll_ceiling_seconds = var.app_drain_ceiling_seconds + var.drain_poll_interval_seconds
  drain_hook_heartbeat       = var.app_drain_ceiling_seconds + var.drain_hook_margin_seconds

  # --- Warmup / health-check grace, DERIVED (ticket 18 AC #4) ---------------
  # One number for both: the same physical event (instance boots → serves traffic)
  # gates "don't health-check me yet" and "don't rotate the next instance yet".
  instance_warmup_seconds = var.container_warmup_seconds + var.bootstrap_overhead_seconds

  # --- Launch-hook heartbeat, DERIVED (aws-production 02 / F6) --------------
  # The hook now completes strictly AFTER the /health gate, so AWS must hold the
  # instance for the WORST-CASE boot-to-health, or a slow-but-healthy boot gets
  # ABANDONed mid-bootstrap. Worst case = every pre-container bootstrap step
  # (var.bootstrap_overhead_seconds, itemised & provisional) + the full health
  # wait ceiling (var.container_warmup_seconds — the SAME variable rendered into
  # user-data as HEALTH_MAX_WAIT, so the ceiling and the hook cannot drift
  # apart). The margin absorbs estimate error in the provisional overhead.
  # Today: 260 + 90 + 250 = 600s — exactly the proven literal it replaces.
  launch_hook_heartbeat = local.instance_warmup_seconds + var.launch_hook_margin_seconds

  # --- Canary checkpoints, DERIVED from fleet_size (ticket 29) --------------
  # First checkpoint = exactly ONE instance (ceil(100/N)%), then 100%. The one
  # replaced instance serves real NLB traffic for canary_soak_seconds before
  # the refresh continues; the abort alarms below are watched the whole time.
  # fleet_size = 1 collapses to [100] — a single box has no subset to canary
  # with, the soak alarms still gate the (whole-fleet) replacement.
  canary_checkpoint_percentages = distinct([ceil(100 / var.fleet_size), 100])
}

# --- Get latest Ubuntu 24.04 AMI ---
# Arch token is substituted from var.instance_architecture. The default ("amd64")
# resolves to the exact same AMI name pattern used historically, so the default
# path produces no launch-template churn.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${var.instance_architecture}-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- SSH Key Pair ---
resource "aws_key_pair" "deploy" {
  key_name   = "${local.env_prefix}-asg-deploy-key"
  public_key = file(var.ssh_public_key_path)

  tags = {
    Project = var.project_name
  }
}

# --- Launch Template ---
resource "aws_launch_template" "msab" {
  name_prefix   = "${local.env_prefix}-lt-"
  image_id      = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  key_name      = aws_key_pair.deploy.key_name

  # IAM instance profile (CloudWatch + ASG lifecycle permissions)
  iam_instance_profile {
    name = var.instance_profile_name
  }

  # Network — place in the first public subnet's VPC
  vpc_security_group_ids = [var.msab_security_group_id]

  # Detailed monitoring for CloudWatch
  monitoring {
    enabled = true
  }

  # Root volume
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = 30
      encrypted             = true
      delete_on_termination = true
    }
  }

  # User data script — same as compute module. Gzipped because the rendered
  # script (~28KB) exceeds EC2's 16KB user-data limit; cloud-init decompresses
  # transparently. Tests assert on the user_data_rendered output, not this attr.
  user_data = base64gzip(local.user_data_rendered)
  # Metadata options (IMDSv2 required)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name    = "${local.env_prefix}-asg-instance"
      Project = var.project_name
      Role    = "msab"
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Project = var.project_name
  }
}

# --- Auto Scaling Group ---
# FIXED SIZE, on purpose: all three capacity fields read the SAME variable, so the
# fleet cannot become elastic by editing one number. Rationale (ticket 06 / 18 AC #2):
# a mediasoup room lives on ONE instance for its whole life, so an extra instance
# relieves nothing that is already hot, and removing an instance drops live calls.
# Capacity moves by hand, from ticket 35's saturation curve.
#
# NOTE for ticket 29 (canary rollout): min = max forecloses launch-before-terminate —
# max_healthy_percentage > 100 needs max_size headroom, so instance refresh here must
# terminate-then-launch and briefly runs below fleet_size. 29 owns that trade-off.
resource "aws_autoscaling_group" "msab" {
  name_prefix         = "${local.env_prefix}-asg-"
  min_size            = var.fleet_size
  max_size            = var.fleet_size
  desired_capacity    = var.fleet_size
  vpc_zone_identifier = var.public_subnet_ids

  # Register instances with NLB target group
  target_group_arns = [var.target_group_arn]

  # Health check via NLB target group. Grace period is DERIVED from the same cold-boot
  # budget as instance_warmup below (ticket 18 AC #4) — both answer "how long until this
  # instance can serve traffic", so they must never be two independent literals.
  health_check_type         = "ELB"
  health_check_grace_period = local.instance_warmup_seconds

  # Simple launch template — used when no instance type fallbacks are configured
  #
  # 🔴 ticket 34: this MUST be `latest_version`, not the literal `"$Latest"`.
  # `instance_refresh` fires only when the ASG resource itself has a diff. With
  # `"$Latest"` neither `id` nor `version` ever changes, so an image_tag bump
  # produced a plan containing ONLY the launch template — the ASG was absent, no
  # refresh started, and the fleet kept running the previous image while
  # deploy.yml's "no refresh found" branch reported the release green.
  # `latest_version` changes on every template revision, so the ASG diffs and the
  # refresh below (canary + soak + abort alarms + auto_rollback) actually runs.
  # ⛔ Do not "simplify" this back to "$Latest".
  dynamic "launch_template" {
    for_each = length(var.instance_type_overrides) == 0 ? [1] : []
    content {
      id      = aws_launch_template.msab.id
      version = aws_launch_template.msab.latest_version
    }
  }

  # Mixed instances policy — used when fallback instance types are configured.
  # Tries each type in priority order (on_demand_allocation_strategy = "prioritized")
  # until one has capacity. All instances are on-demand (no spot).
  dynamic "mixed_instances_policy" {
    for_each = length(var.instance_type_overrides) > 0 ? [1] : []
    content {
      launch_template {
        launch_template_specification {
          launch_template_id = aws_launch_template.msab.id
          # ticket 34 — same reasoning as the simple path above. Do not use "$Latest".
          version = aws_launch_template.msab.latest_version
        }

        dynamic "override" {
          for_each = var.instance_type_overrides
          content {
            instance_type = override.value
          }
        }
      }

      instances_distribution {
        on_demand_base_capacity                  = var.fleet_size
        on_demand_percentage_above_base_capacity = 100
        on_demand_allocation_strategy            = "prioritized"
      }
    }
  }

  # Instance refresh settings (for rolling deployments). Warmup = the derived cold-boot
  # budget (ticket 18 AC #4): container warmup measured in ticket 17 (90s) + the itemised
  # user-data bootstrap cost (var.bootstrap_overhead_seconds) that runs BEFORE the
  # container starts — re-itemised by ticket 19's bootstrap reorder.
  #
  # Ticket 29 — canary rollout, decided here:
  #  * Checkpoints make the first batch exactly ONE instance; checkpoint_delay is the
  #    soak, during which that instance serves real production traffic.
  #  * alarm_specification is the automated continue-or-abort decision: either alarm
  #    entering ALARM at ANY point during the refresh (soak included) fails the refresh —
  #    no human judgment in the loop.
  #  * auto_rollback = true: a failed/aborted refresh rolls the group back to the
  #    previous launch-template version, i.e. the previous image_tag baked into
  #    user-data — the fleet ends on the previous artifact, not mixed.
  #  * Parallelism: after the canary checkpoint passes, min_healthy_percentage = 50
  #    lets AWS replace up to half the fleet per batch. Deliberately better than
  #    serial (halves rollout duration and therefore the mixed-version window) while
  #    bounding concurrent room displacement to 50% of the fleet — the room-pinning
  #    interaction is written down in ticket 29's STATUS block. min = max on the ASG
  #    means terminate-then-launch: the fleet briefly runs below fleet_size (trade-off
  #    owned by ticket 29; launch-before-terminate would need max_size headroom the
  #    fixed-fleet design forbids).
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = local.instance_warmup_seconds
      auto_rollback          = true
      checkpoint_percentages = local.canary_checkpoint_percentages
      checkpoint_delay       = var.canary_soak_seconds
      alarm_specification {
        alarms = [
          aws_cloudwatch_metric_alarm.zero_healthy_hosts.alarm_name,
          aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.alarm_name,
        ]
      }
    }
  }

  # Tags propagated to instances
  tag {
    key                 = "Project"
    value               = var.project_name
    propagate_at_launch = true
  }

  # Ticket 31 / decision D3. The Project tag stays the BARE project name in
  # both environments, so it can no longer identify one fleet on its own once
  # staging and production coexist in the single AWS account of ADR 0028 —
  # .github/workflows/deploy.yml discovers the ASG by tag, and a Project-only
  # filter would return both and pick an arbitrary one. This tag is the
  # discriminator that filter uses. Provider default_tags do NOT reach an ASG
  # (aws_autoscaling_group takes tags only through these blocks), which is why
  # it is declared explicitly here rather than inherited.
  tag {
    key                 = "Environment"
    value               = var.environment
    propagate_at_launch = true
  }

  tag {
    key                 = "ManagedBy"
    value               = "terraform-asg"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Lifecycle Hook: Launching ---
# Gives instances time to complete user-data bootstrap before receiving traffic.
# default_result = ABANDON (ticket 19, fail closed): a bootstrap that dies before
# completing the hook — or before the aws CLI even exists — must terminate the
# instance, never let it drift InService. user-data completes the hook explicitly
# (CONTINUE) only as its LAST act, strictly after `docker run` succeeded AND
# /health returned 200 (aws-production 02) — its EXIT trap sends ABANDON
# immediately on any earlier failure. The heartbeat is DERIVED (locals) from the
# same boot budgets that set the health ceiling and ELB grace, never a literal.
resource "aws_autoscaling_lifecycle_hook" "launching" {
  name                   = "msab-launch-hook"
  autoscaling_group_name = aws_autoscaling_group.msab.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_LAUNCHING"
  heartbeat_timeout      = local.launch_hook_heartbeat
  default_result         = "ABANDON"
}

# --- Lifecycle Hook: Terminating ---
# Gives MSAB time to drain WebRTC rooms before termination
resource "aws_autoscaling_lifecycle_hook" "terminating" {
  name                   = "msab-terminate-hook"
  autoscaling_group_name = aws_autoscaling_group.msab.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_TERMINATING"
  heartbeat_timeout      = local.drain_hook_heartbeat
  default_result         = "CONTINUE" # Terminate even if drain fails
}

# ⛔ NO aws_autoscaling_policy — deliberately. A TargetTracking-on-CPU policy used to live
# here (AUDIT-010); it is REMOVED, not merely un-extended, because the fleet is fixed-size
# (ticket 18 AC #5). The two alarms below are visibility-only: empty alarm_actions, they
# page nobody and scale nothing. Their thresholds are named for the alarms, not for scaling.

# --- CloudWatch Alarm: High Connections (visibility only — no action) ---
resource "aws_cloudwatch_metric_alarm" "high_connections" {
  alarm_name          = "${local.env_prefix}-high-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ActiveConnections"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Average"
  threshold           = var.connections_alarm_high_threshold
  alarm_description   = "WARNING: ActiveConnections > ${var.connections_alarm_high_threshold} for 3 minutes"

  # No alarm_actions, and nothing to act: the scaling policy is gone (AC #5). Visibility only.
  alarm_actions = []

  dimensions = {}
}

# --- CloudWatch Alarm: Low Connections (visibility only) ---
resource "aws_cloudwatch_metric_alarm" "low_connections" {
  alarm_name          = "${local.env_prefix}-low-connections"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 10
  metric_name         = "ActiveConnections"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Average"
  threshold           = var.connections_alarm_low_threshold
  alarm_description   = "INFO: ActiveConnections < ${var.connections_alarm_low_threshold} for 10 minutes"

  alarm_actions = []

  dimensions = {}
}

# --- CloudWatch Alarm: Sustained Unhealthy Host (ticket 29 — canary abort signal) ---
# The refresh's alarm_specification watches this: any target unhealthy for 3 consecutive
# minutes during a rollout means the new build is sick → refresh fails → auto-rollback.
# 3 × 60s is deliberately LONGER than a normal drain blip: a terminating instance is
# deregistered from the target group when termination begins, so it leaves the
# UnHealthyHostCount math quickly — a sustained reading can only be an InService
# instance that keeps failing /health. treat_missing_data = notBreaching so quiet
# periods (metric gaps) never abort a rollout.
resource "aws_cloudwatch_metric_alarm" "refresh_unhealthy_sustained" {
  alarm_name          = "${local.env_prefix}-refresh-unhealthy-sustained"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/NetworkELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Canary/rollout abort: an InService instance has failed /health for 3 consecutive minutes"
  treat_missing_data  = "notBreaching"

  dimensions = {
    TargetGroup  = var.target_group_arn_suffix
    LoadBalancer = var.load_balancer_arn_suffix
  }

  alarm_actions = var.alarm_notification_topic_arn != "" ? [var.alarm_notification_topic_arn] : []
  ok_actions    = var.alarm_notification_topic_arn != "" ? [var.alarm_notification_topic_arn] : []
}

# --- CloudWatch Alarm: Zero Healthy Hosts (total outage detector) ---
# AUDIT-024: Fires when ALL instances behind the NLB are unhealthy.
# This is the earliest warning of a complete audio service outage.
resource "aws_cloudwatch_metric_alarm" "zero_healthy_hosts" {
  alarm_name          = "${local.env_prefix}-zero-healthy-hosts"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/NetworkELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "CRITICAL: No healthy instances behind NLB — total audio outage!"
  treat_missing_data  = "breaching"

  dimensions = {
    TargetGroup  = var.target_group_arn_suffix
    LoadBalancer = var.load_balancer_arn_suffix
  }

  alarm_actions = var.alarm_notification_topic_arn != "" ? [var.alarm_notification_topic_arn] : []
  ok_actions    = var.alarm_notification_topic_arn != "" ? [var.alarm_notification_topic_arn] : []
}

# Rendered user-data script. Kept as a local (and exposed via the
# user_data_rendered output) so tests can assert on the plain text — the
# launch template carries it gzipped, which base64decode() alone can't unpack.
locals {
  user_data_rendered = templatefile("${path.module}/user-data.sh", {
    region                 = var.region
    name_prefix            = local.env_prefix
    ecr_repo_url           = var.ecr_repo_url
    app_port               = var.app_port
    rtc_min_port           = var.rtc_min_port
    rtc_max_port           = var.rtc_max_port
    redis_host             = var.redis_host
    redis_port             = var.redis_port
    redis_cache_host       = var.redis_cache_host
    redis_cache_port       = var.redis_cache_port
    cors_origins           = var.cors_origins
    laravel_api_url        = var.laravel_api_url
    cascade_enabled        = var.cascade_enabled
    affinity_enabled       = var.affinity_enabled
    cloudflare_turn_key_id = var.cloudflare_turn_key_id
    event_queue_url        = var.event_queue_url
    sentry_dsn             = var.sentry_dsn
    sentry_environment     = var.environment
    image_tag              = var.image_tag
    jwt_max_age_seconds    = var.jwt_max_age_seconds
    laravel_api_timeout_ms = var.laravel_api_timeout_ms
    ice_stun_urls          = var.ice_stun_urls

    # Container memory cap, computed from the instance type's RAM (AC #6).
    container_memory_mib = local.container_memory_mib

    # Drain window — all three derived from var.app_drain_ceiling_seconds (AC #3).
    drain_request_seconds       = local.drain_request_seconds
    drain_poll_ceiling_seconds  = local.drain_poll_ceiling_seconds
    drain_poll_interval_seconds = var.drain_poll_interval_seconds
    # Detection lag before the drain even starts — same budget as the drain (AC #3).
    lifecycle_poll_interval_seconds = var.lifecycle_poll_interval_seconds

    # Health-gate ceiling (aws-production 02 / F6): the docker-run→healthy budget,
    # from the SAME variable that feeds the ELB grace period and the launch-hook
    # heartbeat derivation — never a free-standing literal in the script.
    health_max_wait_seconds = var.container_warmup_seconds

    room_broadcast_threshold_up   = var.room_broadcast_threshold_up
    room_broadcast_threshold_down = var.room_broadcast_threshold_down
    broadcast_hls_enabled         = var.broadcast_hls_enabled
    hls_r2_endpoint               = var.hls_r2_endpoint
    hls_r2_bucket                 = var.hls_r2_bucket
    hls_public_base_url           = var.hls_public_base_url

    # ticket 39 — per-instance DNS + TLS.
    manage_instance_dns = var.manage_instance_dns
    audio_domain        = var.audio_domain
    cloudflare_zone_id  = var.cloudflare_zone_id
  })
}
