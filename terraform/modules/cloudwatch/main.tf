# =============================================================================
# CloudWatch Module — Operational Alarms + Dashboard
# =============================================================================
# Alarms for operational visibility (not scaling — those are in autoscaling module).
# These alarms notify via SNS for pager/alert integration.
# Dashboard provides at-a-glance operational visibility across all regions.
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
}

# SNS topic for alerts is GLOBAL now (ticket 32) — see modules/alerting for
# why. This module receives its ARN via var.alerts_topic_arn instead of
# creating its own topic.

# =============================================================================
# TIER0 (EVIDENCE-REPORT alarm-dimension mismatch / F-14 / F-28 / F-86):
# apply during ops window — see plan.
#
# Root cause: MSAB published every FlyLive/MSAB metric ONLY with an
# `InstanceId` dimension, but these alarms queried with `dimensions = {}`, so
# they matched nothing and were deaf since infra creation. SEARCH() across
# InstanceId is NOT an option — CloudWatch rejects SEARCH on metric alarms
# ("SEARCH is not supported on Metric Alarms"). Fix: MSAB now ALSO publishes
# these metrics DIMENSIONLESS (src/infrastructure/cloudwatch.ts); every
# instance writes one datapoint per 60s period into the shared dimensionless
# stream, so a simple 60s alarm with Sum (connections/workers) or Average
# (cpu) is a true fleet aggregate. Statistics corrected from the original
# (Maximum/Minimum were wrong for a fleet view).
# =============================================================================

# --- Alarm: High Connection Count (fleet total) ---
resource "aws_cloudwatch_metric_alarm" "high_connections" {
  alarm_name          = "${local.env_prefix}-high-connections-alert"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "ActiveConnections"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Sum"
  threshold           = var.connection_alert_threshold
  alarm_description   = "ALERT: fleet ActiveConnections > ${var.connection_alert_threshold} for 5 minutes"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  dimensions = {}
}

# --- Alarm: No Healthy Workers (fleet total) ---
resource "aws_cloudwatch_metric_alarm" "no_workers" {
  alarm_name          = "${local.env_prefix}-no-workers-alert"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "WorkerCount"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "CRITICAL: No healthy MediaSoup workers fleet-wide for 2 minutes"
  treat_missing_data  = "breaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  dimensions = {}
}

# --- Alarm: High CPU (fleet average) ---
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  alarm_name          = "${local.env_prefix}-high-cpu-alert"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "WorkerCPU"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Average"
  threshold           = var.cpu_alert_threshold
  alarm_description   = "WARNING: fleet average CPU > ${var.cpu_alert_threshold}% for 5 minutes"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  dimensions = {}
}

# Reverse-pipe failure rate.
# Counts in CloudWatch are cumulative-since-instance-startup; we use RATE()
# to convert to per-second deltas so a fresh failure burst isn't diluted by
# hours of good history. Alarm fires if recent failure ratio > 5% over
# 5 consecutive minutes; the IF() guard avoids noise when there are no
# attempts at all.
resource "aws_cloudwatch_metric_alarm" "reverse_pipe_failure_rate" {
  alarm_name          = "${local.env_prefix}-reverse-pipe-failure-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = 0.05
  alarm_description   = "ALERT: Reverse-pipe setup failure rate > 5% — edge speakers may be silent to origin/other-edge listeners. Check MSAB logs for 'setupReversePipe: failed' or '/internal/pipe/reverse-*' errors."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  metric_query {
    id          = "failure_rate"
    expression  = "IF(rate_attempts > 0, rate_failures / rate_attempts, 0)"
    label       = "Reverse-pipe failure rate"
    return_data = true
  }

  metric_query {
    id    = "failures"
    label = "Failures (cumulative)"
    metric {
      metric_name = "ReversePipeSetupFailure"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Sum"
    }
  }

  metric_query {
    id    = "successes"
    label = "Successes (cumulative)"
    metric {
      metric_name = "ReversePipeSetupSuccess"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "rate_failures"
    expression  = "RATE(failures)"
    label       = "Failure rate (per-second)"
    return_data = false
  }

  metric_query {
    id          = "rate_successes"
    expression  = "RATE(successes)"
    label       = "Success rate (per-second)"
    return_data = false
  }

  metric_query {
    id          = "rate_attempts"
    expression  = "rate_failures + rate_successes"
    label       = "Total attempt rate (per-second)"
    return_data = false
  }
}

# =============================================================================
# Ticket 32 PART 4 — new fleet alarms (saturation-resource coverage)
# =============================================================================
# Every counter-metric alarm below RATE()s a cumulative-since-instance-startup
# counter into a per-second delta — same technique as reverse_pipe_failure_rate
# above. ⚠️ An instance restart resets THAT instance's counter to 0, so the
# fleet-summed rate can dip negative for one evaluation period right after a
# restart (the new instance's 0 drags the sum down while older instances'
# cumulative totals are still being added in). Every alarm below is
# GreaterThanThreshold, so a negative value simply never breaches — this is
# silent BY DESIGN. Do not "fix" it with abs() or a different comparison
# operator; that would make a routine restart page someone.
# =============================================================================

# --- Alarm: Event-loop lag p99 (fleet-worst instance) ---
resource "aws_cloudwatch_metric_alarm" "event_loop_lag_p99" {
  alarm_name          = "${local.env_prefix}-event-loop-lag-p99"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "EventLoopLagP99Seconds"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.event_loop_lag_p99_alert_seconds
  alarm_description   = "WARNING: fleet-worst event-loop p99 lag > ${var.event_loop_lag_p99_alert_seconds}s for 5 minutes — Node's event loop is backed up on at least one instance; WebRTC signaling and REST responses are slow there. Check WorkerCPU and ActiveConnections per-instance (dashboard widgets) to find the affected instance. Threshold class: C — 100ms p99 is convention for user-perceptible jank, never measured on this fleet; retune after the load test."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  dimensions = {}
}

# --- Alarm: Workers Below Expected (UDP port exhaustion PROXY) ---
# There is no direct UDP-port-exhaustion metric. Ports are allocated one per
# mediasoup worker from the WebRTC range (10000-10063 = 64 ports), workers are
# fixed at boot, and a bind failure past that range is a fatal crash — so
# exhaustion shows up as the worker count dropping below expected, which is
# what this alarm watches. Note this also means port exhaustion is
# structurally impossible at the current fleet shape (a handful of workers per
# instance vs 64 ports); the alarm is here for coverage and would only become
# load-bearing above ~64 workers on one instance.
#
# 🔴 THE EVALUATION WINDOW IS A NOISE CONTROL — see
# var.workers_below_expected_evaluation_periods for the full derivation.
# Short version: the ASG is min=max (fixed-size, ticket 18 AC #2), so an
# instance refresh TERMINATES then launches. The fleet legitimately runs below
# expected for the whole cold-boot budget of every instance it replaces
# (container_warmup_seconds + bootstrap_overhead_seconds ≈ 90 + 260 = 350s
# each — the instance_warmup_seconds local in modules/autoscaling), i.e. ~700s
# at fleet_size = 2. The window is sized to clear that, because an alarm that
# fires on every routine deploy is one that gets muted — and a muted alarm is
# strictly worse than no alarm, since it also looks like coverage.
#
# ⛔ Deploy-time health is NOT this alarm's job. Ticket 29 owns it: canary
# instance refresh, 300s soak, and alarm-driven auto-rollback on the
# NLB-native refresh_unhealthy_sustained alarm. This alarm is steady-state
# only. Do not shorten the window to "catch deploys faster" — that is a
# different alarm's responsibility and would only recreate the noise.
resource "aws_cloudwatch_metric_alarm" "workers_below_expected" {
  alarm_name          = "${local.env_prefix}-workers-below-expected"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = var.workers_below_expected_evaluation_periods
  metric_name         = "WorkerCount"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Sum"
  threshold           = var.expected_total_workers
  alarm_description   = "WARNING: fleet WorkerCount < ${var.expected_total_workers} for ${var.workers_below_expected_evaluation_periods} minutes — proxy for UDP WebRTC-port exhaustion (see module comment above). The window is sized to clear a routine rolling deploy's cold-boot shortfall, so an ALARM here means a sustained worker deficit that a deploy does NOT explain: check for repeated container crashes, a failed instance refresh stuck mid-flight, or mediasoup workers dying at boot. Threshold class: B — structural proxy (threshold is fleet_size × per-instance vCPU-1, not a measurement)."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  dimensions = {}
}

# --- Alarm: Routers per worker (fleet-worst worker) ---
resource "aws_cloudwatch_metric_alarm" "routers_per_worker_high" {
  alarm_name          = "${local.env_prefix}-routers-per-worker-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "RoutersPerWorkerMax"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.routers_per_worker_alert_threshold
  alarm_description   = "WARNING: worst mediasoup worker's router count > ${var.routers_per_worker_alert_threshold} for 5 minutes — a single worker may be carrying too many rooms. Check room-to-worker distribution on the affected instance. Threshold class: C — no measured ceiling exists; retune after the load test."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  dimensions = {}
}

# --- Alarm: Redis degradation rate (fleet) ---
# Any sustained positive rate is already an anomaly — the documented steady
# state of this counter is zero — so the threshold is a bare 0, not a tuned
# percentage.
resource "aws_cloudwatch_metric_alarm" "redis_degradation_rate" {
  alarm_name          = "${local.env_prefix}-redis-degradation-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = 0
  alarm_description   = "ALERT: Redis degradation events are occurring fleet-wide (RATE > 0 for 5 minutes) — the state-store adapter is falling back from its primary path. Check MSAB logs for Redis connection/timeout errors and Redis/ElastiCache health. Threshold class: B — documented steady state of this counter is zero."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  metric_query {
    id          = "rate_degradation"
    expression  = "RATE(degradation_total)"
    label       = "Redis degradation rate (per-second)"
    return_data = true
  }

  metric_query {
    id    = "degradation_total"
    label = "Redis degradation events (cumulative)"
    metric {
      metric_name = "RedisDegradationTotal"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Sum"
      dimensions  = {}
    }
  }
}

# --- Alarm: Socket registration failures rate (fleet) ---
resource "aws_cloudwatch_metric_alarm" "socket_registration_failures" {
  alarm_name          = "${local.env_prefix}-socket-registration-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = 0
  alarm_description   = "ALERT: socket registration failures fleet-wide (RATE > 0 for 5 minutes) — Redis was unreachable during auth, so a connecting client's socket never registered. Check Redis/ElastiCache reachability and MSAB auth logs. Threshold class: B — documented steady state is zero (Redis unreachable during auth)."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  metric_query {
    id          = "rate_failures"
    expression  = "RATE(failures_total)"
    label       = "Socket registration failure rate (per-second)"
    return_data = true
  }

  metric_query {
    id    = "failures_total"
    label = "Socket registration failures (cumulative)"
    metric {
      metric_name = "SocketRegistrationFailures"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Sum"
      dimensions  = {}
    }
  }
}

# --- Alarm: HLS mixer port pool utilization (fleet-worst instance) ---
# IF() guards divide-by-zero the same way reverse_pipe_failure_rate's IF()
# guards its own division above: capacity is 0 or absent when no instance is
# running the broadcast tier yet (or between metric-publish periods), and
# Maximum/0 would be a math error, not "0% used".
#
# Maximum on both operands assumes uniform per-instance pool capacity — if a
# future change makes HlsMixerPortsCapacity vary by instance, this ratio could
# silently mix one instance's in-use count against a DIFFERENT instance's
# capacity. Revisit if capacity ever becomes instance-type-dependent.
resource "aws_cloudwatch_metric_alarm" "hls_mixer_port_pool_high" {
  alarm_name          = "${local.env_prefix}-hls-mixer-port-pool-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = var.hls_mixer_port_pool_alert_ratio
  alarm_description   = "WARNING: HLS mixer UDP port pool > ${var.hls_mixer_port_pool_alert_ratio * 100}% utilized for 5 minutes — the broadcast transcoder is approaching its port ceiling; new HLS publishers may soon fail to allocate a mixer port. Check HlsMixerPortsInUse/Capacity per instance and consider raising the pool or investigating stuck mixers. Threshold class: B — ratio against the pool's own published capacity, so it can't go stale if the range changes."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  metric_query {
    id          = "port_pool_ratio"
    expression  = "IF(capacity > 0, in_use / capacity, 0)"
    label       = "HLS mixer port pool utilization"
    return_data = true
  }

  metric_query {
    id    = "in_use"
    label = "HLS mixer ports in use (fleet-worst)"
    metric {
      metric_name = "HlsMixerPortsInUse"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Maximum"
      dimensions  = {}
    }
  }

  metric_query {
    id    = "capacity"
    label = "HLS mixer port pool capacity (fleet-worst)"
    metric {
      metric_name = "HlsMixerPortsCapacity"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Maximum"
      dimensions  = {}
    }
  }
}

# --- Alarm: HLS publisher unexpected exits rate (fleet) ---
resource "aws_cloudwatch_metric_alarm" "hls_publisher_unexpected_exits" {
  alarm_name          = "${local.env_prefix}-hls-publisher-unexpected-exits"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = 0
  alarm_description   = "ALERT: unexpected FFmpeg/HLS publisher exits fleet-wide (RATE > 0 for 3 minutes) — an HLS publisher process died without a clean shutdown. Check MSAB logs for the affected instance's HLS publisher output and restart behaviour. Threshold class: B — an unexpected FFmpeg death has no normal cause."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  metric_query {
    id          = "rate_exits"
    expression  = "RATE(exits_total)"
    label       = "Unexpected HLS publisher exit rate (per-second)"
    return_data = true
  }

  metric_query {
    id    = "exits_total"
    label = "Unexpected HLS publisher exits (cumulative)"
    metric {
      metric_name = "HlsPublisherExitsUnexpected"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Sum"
      dimensions  = {}
    }
  }
}

# --- Alarm: Sentry dropped events rate (fleet, AC-5) ---
resource "aws_cloudwatch_metric_alarm" "sentry_events_dropped" {
  alarm_name          = "${local.env_prefix}-sentry-events-dropped"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = 0
  alarm_description   = "ALERT: Sentry is dropping events fleet-wide (RATE > 0 for 5 minutes) — error tracking (AC-5) is silently losing data, e.g. from Sentry-side rate limiting or a misconfigured DSN. Check the Sentry project's ingestion/rate-limit dashboard and MSAB's SENTRY_DSN config. Threshold class: B — the drop counter's documented steady state is zero."
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  metric_query {
    id          = "rate_dropped"
    expression  = "RATE(dropped_total)"
    label       = "Sentry dropped-event rate (per-second)"
    return_data = true
  }

  metric_query {
    id    = "dropped_total"
    label = "Sentry dropped events (cumulative)"
    metric {
      metric_name = "SentryDroppedTotal"
      namespace   = "FlyLive/MSAB"
      period      = 60
      stat        = "Sum"
      dimensions  = {}
    }
  }
}

# =============================================================================
# CloudWatch Dashboard — MSAB Operations
# =============================================================================
# Single dashboard showing all custom metrics from the FlyLive/MSAB namespace.
# Uses SEARCH() to auto-discover instances — no hardcoded instance IDs.
# =============================================================================

resource "aws_cloudwatch_dashboard" "msab" {
  # Region-scoped name: CloudWatch dashboards are account-GLOBAL (unlike alarms,
  # which are regional). A shared name makes every region's module fight over one
  # dashboard — perpetual diffs and concurrent-PutDashboard ConflictExceptions on
  # apply. One dashboard per region eliminates the collision (realtime-07).
  dashboard_name = "${local.env_prefix}-operations-${var.aws_region}"

  dashboard_body = jsonencode({
    widgets = [
      # ── Row 1: Key metrics (single-value + line) ─────────────────
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 6
        height = 6
        properties = {
          title   = "Active Connections"
          metrics = [["FlyLive/MSAB", "ActiveConnections", { stat = "Sum" }]]
          view    = "timeSeries"
          region  = var.aws_region
          period  = 60
          yAxis   = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 6
        y      = 0
        width  = 6
        height = 6
        properties = {
          title   = "Active Rooms"
          metrics = [["FlyLive/MSAB", "ActiveRooms", { stat = "Sum" }]]
          view    = "timeSeries"
          region  = var.aws_region
          period  = 60
          yAxis   = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 6
        height = 6
        properties = {
          title   = "Worker Count"
          metrics = [["FlyLive/MSAB", "WorkerCount", { stat = "Sum" }]]
          view    = "timeSeries"
          region  = var.aws_region
          period  = 60
          yAxis   = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 18
        y      = 0
        width  = 6
        height = 6
        properties = {
          title   = "Worker CPU %"
          metrics = [["FlyLive/MSAB", "WorkerCPU", { stat = "Average" }]]
          view    = "timeSeries"
          region  = var.aws_region
          period  = 60
          yAxis   = { left = { min = 0, max = 100 } }
          annotations = {
            horizontal = [
              {
                label = "Alert threshold"
                value = var.cpu_alert_threshold
                color = "#d13212"
              }
            ]
          }
        }
      },

      # ── Row 2: Per-instance breakdown ────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title = "Connections per Instance"
          metrics = [
            [{ expression = "SEARCH('{FlyLive/MSAB,InstanceId} MetricName=\"ActiveConnections\"', 'Sum', 60)", id = "e1" }]
          ]
          view   = "timeSeries"
          region = var.aws_region
          period = 60
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title = "CPU per Instance"
          metrics = [
            [{ expression = "SEARCH('{FlyLive/MSAB,InstanceId} MetricName=\"WorkerCPU\"', 'Average', 60)", id = "e1" }]
          ]
          view   = "timeSeries"
          region = var.aws_region
          period = 60
          yAxis  = { left = { min = 0, max = 100 } }
        }
      },

      # ── Row 3: NLB metrics ──────────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 8
        height = 6
        properties = {
          title = "NLB Active Flows (TCP)"
          metrics = [
            [{ expression = "SEARCH('{AWS/NetworkELB,LoadBalancer} MetricName=\"ActiveFlowCount\"', 'Average', 300)", id = "e1" }]
          ]
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 12
        width  = 8
        height = 6
        properties = {
          title = "NLB New Flows (TCP)"
          metrics = [
            [{ expression = "SEARCH('{AWS/NetworkELB,LoadBalancer} MetricName=\"NewFlowCount\"', 'Sum', 300)", id = "e1" }]
          ]
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 12
        width  = 8
        height = 6
        properties = {
          title = "NLB Processed Bytes"
          metrics = [
            [{ expression = "SEARCH('{AWS/NetworkELB,LoadBalancer} MetricName=\"ProcessedBytes\"', 'Sum', 300)", id = "e1" }]
          ]
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          yAxis  = { left = { min = 0 } }
        }
      },

      # ── Row 4: ASG + Alarm status ──────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title = "ASG Instance Count"
          metrics = [
            [{ expression = "SEARCH('{AWS/AutoScaling,AutoScalingGroupName} MetricName=\"GroupInServiceInstances\"', 'Average', 300)", id = "e1" }]
          ]
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "alarm"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title = "Alarm Status"
          alarms = [
            aws_cloudwatch_metric_alarm.high_connections.arn,
            aws_cloudwatch_metric_alarm.no_workers.arn,
            aws_cloudwatch_metric_alarm.high_cpu.arn,
          ]
        }
      }
    ]
  })
}
