# =============================================================================
# Saturation alarms (ticket 32) — rendered-plan assertions
# =============================================================================
# Offline, mocked-provider tests. Same pattern as
# tests/dynamic_metric_discovery.tftest.hcl and tests/plan_assertions.tftest.hcl.
#
# WHAT THESE PROTECT
#
# 1. THE DEAF-ALARM DEFECT. A CloudWatch metric alarm with no `dimensions`
#    reads the DIMENSIONLESS stream — it does not mean "any instance". MSAB
#    publishes every alarm-able metric twice per tick (once with InstanceId,
#    once dimensionless) precisely so fleet alarms can read that shared stream.
#    An alarm that instead carried a dimension, or a metric-math sub-metric
#    that did, would silently match nothing and sit in OK forever. That already
#    happened once to reverse_pipe_failure_rate (caught pre-apply, 2026-08-11).
#    Every assertion below marked DEAF-ALARM GUARD exists for that.
#
# 2. THE alarm_names ROSTER. scripts/verify-alarms.mjs compares live CloudWatch
#    against the root `alarm_names` output. An alarm missing from that list is
#    not checked by the verifier — it would under-check and still report
#    success. So the roster length is pinned: add an alarm without listing it
#    and this suite fails.
#
# ⚠️ These are PLAN-time assertions. They prove the config declares the right
# thing. They cannot prove the alarms exist in AWS, are armed, or that anyone
# is subscribed to the topic — that is `npm run alarms:verify` against a live
# account, and it is a separate, apply-gated acceptance criterion.
# =============================================================================

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }
}

variables {
  environment      = "production"
  project_name     = "flylive-audio"
  aws_region       = "ap-south-1"
  alerts_topic_arn = "arn:aws:sns:ap-south-1:111111111111:flylive-audio-production-alerts"
}

# -----------------------------------------------------------------------------
# The eight ticket-32 saturation alarms: right metric, right shape, wired to
# the alerts topic, and reading the dimensionless stream.
# -----------------------------------------------------------------------------
run "saturation_alarms_read_the_right_metrics_and_are_wired_to_alerts" {
  command = plan

  module {
    source = "./modules/cloudwatch"
  }

  # --- Simple (non-math) alarms: metric, statistic, cadence ---

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.event_loop_lag_p99.metric_name == "EventLoopLagP99Seconds" &&
      aws_cloudwatch_metric_alarm.event_loop_lag_p99.namespace == "FlyLive/MSAB" &&
      aws_cloudwatch_metric_alarm.event_loop_lag_p99.period == 60 &&
      aws_cloudwatch_metric_alarm.event_loop_lag_p99.statistic == "Maximum"
    )
    error_message = "event_loop_lag_p99 must read EventLoopLagP99Seconds from FlyLive/MSAB at 60s using Maximum (fleet-WORST instance — Average would let one wedged instance hide behind healthy ones)"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.workers_below_expected.metric_name == "WorkerCount" &&
      aws_cloudwatch_metric_alarm.workers_below_expected.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.workers_below_expected.comparison_operator == "LessThanThreshold"
    )
    error_message = "workers_below_expected must alarm on the fleet TOTAL WorkerCount (Sum) falling below the expected count"
  }

  # The evaluation window is a noise control, not a sensitivity knob: the
  # fixed-size ASG terminates-then-launches, so a routine deploy legitimately
  # runs the fleet below expected for ~350s per replaced instance. A window
  # shorter than that fires on every deploy, and an always-firing alarm gets
  # muted. See var.workers_below_expected_evaluation_periods for the derivation.
  assert {
    condition     = aws_cloudwatch_metric_alarm.workers_below_expected.evaluation_periods >= 12
    error_message = "workers_below_expected's window must clear a rolling deploy's cold-boot shortfall (~350s per instance, ~700s at fleet_size 2). Shorter and it fires on every deploy, gets muted, and stops being coverage. Deploy-time health belongs to ticket 29, not this alarm."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.routers_per_worker_high.metric_name == "RoutersPerWorkerMax" &&
      aws_cloudwatch_metric_alarm.routers_per_worker_high.statistic == "Maximum"
    )
    error_message = "routers_per_worker_high must read RoutersPerWorkerMax using Maximum (worst worker on the worst instance)"
  }

  # --- Every new alarm pages the alerts topic, on both ALARM and OK ---
  # ok_actions matter as much as alarm_actions: without them a resolved alarm
  # never tells anyone it recovered, and the operator is left assuming the
  # incident is still open.

  assert {
    condition = alltrue([
      for a in [
        aws_cloudwatch_metric_alarm.event_loop_lag_p99,
        aws_cloudwatch_metric_alarm.workers_below_expected,
        aws_cloudwatch_metric_alarm.routers_per_worker_high,
        aws_cloudwatch_metric_alarm.redis_degradation_rate,
        aws_cloudwatch_metric_alarm.socket_registration_failures,
        aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high,
        aws_cloudwatch_metric_alarm.hls_publisher_unexpected_exits,
        aws_cloudwatch_metric_alarm.sentry_events_dropped,
      ] : a.alarm_actions == toset([var.alerts_topic_arn]) && a.ok_actions == toset([var.alerts_topic_arn])
    ])
    error_message = "every saturation alarm must fire AND resolve to the alerts topic — an alarm with no ok_action leaves the operator unable to tell a recovered incident from an ongoing one"
  }

  # --- DEAF-ALARM GUARD (simple alarms) ---

  assert {
    condition = alltrue([
      for a in [
        aws_cloudwatch_metric_alarm.event_loop_lag_p99,
        aws_cloudwatch_metric_alarm.workers_below_expected,
        aws_cloudwatch_metric_alarm.routers_per_worker_high,
      ] : length(a.dimensions) == 0
    ])
    error_message = "DEAF-ALARM GUARD: fleet alarms must query the DIMENSIONLESS stream (dimensions = {}). A dimension here matches nothing, and treat_missing_data makes that look healthy."
  }

  # --- DEAF-ALARM GUARD (metric-math alarms) ---
  # The defect that shipped was in a metric_query sub-metric, not a top-level
  # dimensions block, so the guard has to reach inside metric_query too.

  assert {
    condition = alltrue(flatten([
      for a in [
        aws_cloudwatch_metric_alarm.redis_degradation_rate,
        aws_cloudwatch_metric_alarm.socket_registration_failures,
        aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high,
        aws_cloudwatch_metric_alarm.hls_publisher_unexpected_exits,
        aws_cloudwatch_metric_alarm.sentry_events_dropped,
        aws_cloudwatch_metric_alarm.reverse_pipe_failure_rate,
        ] : [
        for q in a.metric_query : [
          for m in q.metric : try(length(m.dimensions), 0) == 0
        ]
      ]
    ]))
    error_message = "DEAF-ALARM GUARD: every metric_query sub-metric must also be dimensionless. This is exactly where reverse_pipe_failure_rate was broken — the alarm looked fine and could never fire."
  }

  # --- Metric-math alarms read the metrics they claim to ---

  assert {
    condition = anytrue(flatten([
      for q in aws_cloudwatch_metric_alarm.redis_degradation_rate.metric_query : [
        for m in q.metric : m.metric_name == "RedisDegradationTotal"
      ]
    ]))
    error_message = "redis_degradation_rate must read RedisDegradationTotal"
  }

  assert {
    condition = anytrue(flatten([
      for q in aws_cloudwatch_metric_alarm.sentry_events_dropped.metric_query : [
        for m in q.metric : m.metric_name == "SentryDroppedTotal"
      ]
    ]))
    error_message = "sentry_events_dropped must consume the already-emitted SentryDroppedTotal counter (ticket 32 AC-5: consume the existing drop counter, do not add a new metric)"
  }

  assert {
    condition = anytrue(flatten([
      for q in aws_cloudwatch_metric_alarm.hls_publisher_unexpected_exits.metric_query : [
        for m in q.metric : m.metric_name == "HlsPublisherExitsUnexpected"
      ]
    ]))
    error_message = "hls_publisher_unexpected_exits must read HlsPublisherExitsUnexpected — NOT the total exits, which includes every routine restart and would page on normal operation"
  }

  # The transcoder pool alarm is a RATIO against the pool's own published
  # capacity, so it cannot go stale if the port range is ever resized.
  assert {
    condition = (
      anytrue(flatten([
        for q in aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high.metric_query : [
          for m in q.metric : m.metric_name == "HlsMixerPortsInUse"
        ]
      ])) &&
      anytrue(flatten([
        for q in aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high.metric_query : [
          for m in q.metric : m.metric_name == "HlsMixerPortsCapacity"
        ]
      ]))
    )
    error_message = "hls_mixer_port_pool_high must divide HlsMixerPortsInUse by the published HlsMixerPortsCapacity, not compare against a hardcoded pool size"
  }

  # Divide-by-zero guard: capacity is 0 until a MixerPortRegistry is
  # constructed (HLS is feature-flagged off by default), so the expression
  # must yield 0 rather than erroring the whole alarm into INSUFFICIENT_DATA.
  assert {
    condition = anytrue([
      for q in aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high.metric_query :
      try(strcontains(q.expression, "IF("), false)
    ])
    error_message = "hls_mixer_port_pool_high must guard its division with IF() — HlsMixerPortsCapacity is 0 while HLS is disabled, and an erroring expression takes the alarm out of service silently"
  }
}

# -----------------------------------------------------------------------------
# Threshold honesty. This project grades every threshold A (measured or a
# structural invariant) / B (anchored to a shipped constant or documented
# design property) / C (judgment — a guess). Eleven of thirteen load-test
# thresholds are B or C, and saying so plainly is the point: a false A is far
# worse than an honest C, because it stops anyone re-examining the number.
# Each alarm description must carry its class so an operator reading the page
# at 3am knows how much to trust the number that woke them.
# -----------------------------------------------------------------------------
run "every_saturation_alarm_declares_its_threshold_class" {
  command = plan

  module {
    source = "./modules/cloudwatch"
  }

  assert {
    condition = alltrue([
      for a in [
        aws_cloudwatch_metric_alarm.event_loop_lag_p99,
        aws_cloudwatch_metric_alarm.workers_below_expected,
        aws_cloudwatch_metric_alarm.routers_per_worker_high,
        aws_cloudwatch_metric_alarm.redis_degradation_rate,
        aws_cloudwatch_metric_alarm.socket_registration_failures,
        aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high,
        aws_cloudwatch_metric_alarm.hls_publisher_unexpected_exits,
        aws_cloudwatch_metric_alarm.sentry_events_dropped,
      ] : strcontains(a.alarm_description, "Threshold class:")
    ])
    error_message = "every saturation alarm's description must state its threshold class (A measured / B anchored / C judgment) — an unlabelled number reads as authoritative when most of these are explicitly guesses pending the load test"
  }
}

# -----------------------------------------------------------------------------
# The alarm_names roster. scripts/verify-alarms.mjs only checks what this
# output lists, so an unlisted alarm is an unverified alarm.
# -----------------------------------------------------------------------------
run "alarm_names_roster_lists_every_alarm_this_module_declares" {
  command = plan

  module {
    source = "./modules/cloudwatch"
  }

  # 4 original TIER0 fleet alarms + 8 ticket-32 saturation alarms.
  # ⛔ If you add an alarm, add it to modules/cloudwatch/outputs.tf's
  # alarm_names AND bump this number. Failing here is the intended behaviour,
  # not an obstacle: an alarm missing from the roster is invisible to the live
  # verifier, which would then pass while under-checking.
  assert {
    condition     = length(output.alarm_names) == 12
    error_message = "alarm_names must list every alarm this module declares (expected 12: 4 original + 8 saturation). Add the new alarm to outputs.tf and update this count."
  }

  assert {
    condition = alltrue([
      for name in [
        aws_cloudwatch_metric_alarm.event_loop_lag_p99.alarm_name,
        aws_cloudwatch_metric_alarm.workers_below_expected.alarm_name,
        aws_cloudwatch_metric_alarm.routers_per_worker_high.alarm_name,
        aws_cloudwatch_metric_alarm.redis_degradation_rate.alarm_name,
        aws_cloudwatch_metric_alarm.socket_registration_failures.alarm_name,
        aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high.alarm_name,
        aws_cloudwatch_metric_alarm.hls_publisher_unexpected_exits.alarm_name,
        aws_cloudwatch_metric_alarm.sentry_events_dropped.alarm_name,
      ] : contains(output.alarm_names, name)
    ])
    error_message = "every saturation alarm must appear in the alarm_names roster consumed by scripts/verify-alarms.mjs"
  }
}
