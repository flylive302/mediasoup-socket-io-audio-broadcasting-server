# CloudWatch Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "aws_region" {
  description = "AWS region for dashboard metric queries"
  type        = string
}

variable "alerts_topic_arn" {
  description = "SNS topic ARN for alert notifications — sourced from the global modules/alerting module (ticket 32), not created here"
  type        = string
}

variable "connection_alert_threshold" {
  description = "ActiveConnections threshold for alert (not scaling)"
  type        = number
  default     = 800
}

variable "cpu_alert_threshold" {
  description = "WorkerCPU percentage threshold for alert"
  type        = number
  default     = 85
}

# =============================================================================
# Ticket 32 PART 4 — new fleet alarm thresholds
# =============================================================================

variable "event_loop_lag_p99_alert_seconds" {
  description = "EventLoopLagP99Seconds threshold (fleet-worst) above which event_loop_lag_p99 fires. Threshold class C: 100ms p99 is convention for user-perceptible jank, never measured on this fleet — retune after the load test (ticket 35)."
  type        = number
  default     = 0.1
}

variable "expected_total_workers" {
  description = <<-EOT
    Fleet-wide mediasoup WorkerCount the workers_below_expected alarm treats as healthy.
    modules/region ALWAYS overrides this with fleet_size × modules/autoscaling's
    workers_per_instance output (vCPU - 1 per instance, ticket 24) — see modules/region/
    main.tf. This default (6 = the current fleet_size(2) × c7i.xlarge's 3 workers-per-
    instance) only matters when this module is run or tested standalone (e.g.
    tests/dynamic_metric_discovery.tftest.hcl); it is never relied on in the real stack.
  EOT
  type        = number
  default     = 6
}

variable "workers_below_expected_evaluation_periods" {
  description = <<-EOT
    How many consecutive 60s periods WorkerCount must sit below expected_total_workers
    before workers_below_expected fires.

    🔴 This is a NOISE control, not a sensitivity knob, and it is derived — do not lower it
    casually. The ASG is fixed-size (min=max, ticket 18), so an instance refresh
    TERMINATES then launches: the fleet legitimately runs below expected for the whole
    cold-boot budget of EVERY instance it replaces (instance_warmup_seconds ≈ 350s each,
    sequential). At fleet_size = 2 that is ~700s of honest, expected shortfall on a routine
    deploy. A window shorter than that guarantees the alarm fires on every single deploy —
    and an alarm that always fires is one that gets muted, which is how this project
    previously lost three days of error monitoring.

    15 periods (15 min) clears a 2-instance refresh with margin.

    ⚠️ RE-DERIVE THIS IF fleet_size GROWS. The shortfall scales with the number of
    instances refreshed (fleet_size × ~350s); at fleet_size = 4 this default is already too
    short. It is deliberately a plain variable rather than a computed local so that the
    trade-off stays visible and a reviewer must think about it.

    ⛔ Do NOT "fix" the deploy noise by making this alarm more sensitive instead. Deploy-time
    health is ticket 29's job (canary instance refresh, 300s soak, alarm-driven auto-rollback
    on the NLB-native refresh_unhealthy_sustained alarm). THIS alarm exists for steady state.
  EOT
  type        = number
  default     = 15
}

variable "routers_per_worker_alert_threshold" {
  description = "RoutersPerWorkerMax threshold (fleet-worst worker) above which routers_per_worker_high fires. Threshold class C: no measured ceiling exists — retune after the load test (ticket 35)."
  type        = number
  default     = 100
}

variable "hls_mixer_port_pool_alert_ratio" {
  description = "HlsMixerPortsInUse / HlsMixerPortsCapacity ratio above which hls_mixer_port_pool_high fires. Threshold class B: a ratio against the pool's own published capacity, so it can't go stale if the range changes."
  type        = number
  default     = 0.8
}
