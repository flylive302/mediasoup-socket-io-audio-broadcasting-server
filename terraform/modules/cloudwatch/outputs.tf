# CloudWatch Module — Outputs

output "dashboard_name" {
  description = "CloudWatch dashboard name"
  value       = aws_cloudwatch_dashboard.msab.dashboard_name
}

output "alarm_names" {
  description = "Names of every CloudWatch alarm this module declares (4 original TIER0 fleet alarms + 8 ticket-32-PART-4 saturation alarms) — consumed by the root alarm_names output for scripts/verify-alarms.mjs"
  value = [
    aws_cloudwatch_metric_alarm.high_connections.alarm_name,
    aws_cloudwatch_metric_alarm.no_workers.alarm_name,
    aws_cloudwatch_metric_alarm.high_cpu.alarm_name,
    aws_cloudwatch_metric_alarm.reverse_pipe_failure_rate.alarm_name,
    aws_cloudwatch_metric_alarm.event_loop_lag_p99.alarm_name,
    aws_cloudwatch_metric_alarm.workers_below_expected.alarm_name,
    aws_cloudwatch_metric_alarm.routers_per_worker_high.alarm_name,
    aws_cloudwatch_metric_alarm.redis_degradation_rate.alarm_name,
    aws_cloudwatch_metric_alarm.socket_registration_failures.alarm_name,
    aws_cloudwatch_metric_alarm.hls_mixer_port_pool_high.alarm_name,
    aws_cloudwatch_metric_alarm.hls_publisher_unexpected_exits.alarm_name,
    aws_cloudwatch_metric_alarm.sentry_events_dropped.alarm_name,
  ]
}
