# =============================================================================
# ticket 29 — canary rollout: checkpoints, soak, automated abort, auto-rollback
# =============================================================================
# Module-scoped runs against ./modules/autoscaling (same isolation rule as
# drain_window.tftest.hcl — module-scoped runs cannot share a file with
# root-module runs).
#
# What is under test: the rollout's four load-bearing properties —
#   1. the first refresh batch is exactly ONE instance (canary),
#   2. the soak outlasts the abort alarm's full detection window,
#   3. the continue-or-abort decision is wired to alarms (automated, no human),
#   4. a failed refresh auto-rolls back to the previous launch template
#      (= previous image_tag, since the tag is baked into user-data).
# =============================================================================

mock_provider "aws" {}

variables {
  region                 = "ap-south-1"
  project_name           = "flylive-audio"
  environment            = "production"
  ssh_public_key_path    = "./tests/fixtures/id_ed25519.pub"
  instance_profile_name  = "mock-profile"
  msab_security_group_id = "sg-mock"
  public_subnet_ids      = ["subnet-mock-a", "subnet-mock-b"]
  target_group_arn       = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:targetgroup/mock/abc"
  ecr_repo_url           = "111111111111.dkr.ecr.ap-south-1.amazonaws.com/flylive-audio/msab"
  redis_host             = "mock-redis"
  redis_cache_host       = "mock-redis-cache"
  image_tag              = "sha-deadbeef"
}

# -----------------------------------------------------------------------------
# Canary batch size: ceil(100/N)% replaces exactly one instance, then 100%.
# -----------------------------------------------------------------------------
run "first_checkpoint_is_exactly_one_instance" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    fleet_size = 4
  }

  assert {
    condition     = aws_autoscaling_group.msab.instance_refresh[0].preferences[0].checkpoint_percentages[0] == 25
    error_message = "With fleet_size = 4 the first checkpoint must be 25% — exactly one canary instance"
  }

  assert {
    condition     = element(aws_autoscaling_group.msab.instance_refresh[0].preferences[0].checkpoint_percentages, length(aws_autoscaling_group.msab.instance_refresh[0].preferences[0].checkpoint_percentages) - 1) == 100
    error_message = "The final checkpoint must be 100% — the refresh must finish the whole fleet"
  }
}

run "single_box_fleet_collapses_to_one_checkpoint" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    fleet_size = 1
  }

  # fleet_size = 1 has no subset to canary with: ceil(100/1) = 100 and
  # distinct() must collapse [100, 100] to [100], or AWS rejects the refresh
  # (checkpoint percentages must be strictly increasing).
  assert {
    condition     = aws_autoscaling_group.msab.instance_refresh[0].preferences[0].checkpoint_percentages == tolist([100])
    error_message = "fleet_size = 1 must produce exactly one checkpoint [100] — duplicate percentages are rejected by AWS"
  }
}

# -----------------------------------------------------------------------------
# The soak must outlast the abort alarm's worst-case detection:
#   NLB unhealthy flag: unhealthy_threshold(3) × interval(30s) = 90s
#   + alarm: evaluation_periods × period in the unhealthy state
# A shorter soak can end before a sick canary can abort the rollout — which
# silently turns the canary into a formality.
# -----------------------------------------------------------------------------
run "soak_outlasts_abort_detection_window" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.canary_soak_seconds >= (3 * 30) + (aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.evaluation_periods * aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.period)
    error_message = "canary_soak_seconds must be >= NLB unhealthy detection (90s) + the abort alarm's full evaluation window — otherwise the soak ends before a sick canary can fire the abort"
  }

  assert {
    condition     = aws_autoscaling_group.msab.instance_refresh[0].preferences[0].checkpoint_delay == tostring(var.canary_soak_seconds)
    error_message = "checkpoint_delay must be var.canary_soak_seconds — one source of truth for the soak"
  }
}

# -----------------------------------------------------------------------------
# Automated continue-or-abort + rollback-to-previous-artifact.
# -----------------------------------------------------------------------------
run "abort_is_alarm_driven_and_rolls_back" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = aws_autoscaling_group.msab.instance_refresh[0].preferences[0].auto_rollback == true
    error_message = "auto_rollback must be true — an aborted rollout must leave the fleet on the previous launch template (previous image_tag), not mixed"
  }

  assert {
    condition     = contains(aws_autoscaling_group.msab.instance_refresh[0].preferences[0].alarm_specification[0].alarms, "flylive-audio-production-refresh-unhealthy-sustained")
    error_message = "The refresh must watch the sustained-unhealthy alarm — it is the automated abort signal"
  }

  assert {
    condition     = contains(aws_autoscaling_group.msab.instance_refresh[0].preferences[0].alarm_specification[0].alarms, "flylive-audio-production-zero-healthy-hosts")
    error_message = "The refresh must watch the zero-healthy-hosts alarm — a total outage mid-rollout must abort it"
  }
}

# -----------------------------------------------------------------------------
# The abort alarm itself: sustained (3 min), not blip-sensitive, and quiet
# metric gaps must never abort a rollout.
# -----------------------------------------------------------------------------
run "abort_alarm_is_sustained_and_missing_data_safe" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.evaluation_periods * aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.period >= 180
    error_message = "The abort alarm must require >= 3 sustained minutes — shorter windows abort on drain/deregistration blips"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.treat_missing_data == "notBreaching"
    error_message = "treat_missing_data must be notBreaching — a metric gap is not a sick canary"
  }
}
