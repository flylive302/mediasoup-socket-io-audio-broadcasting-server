# Auto Scaling Module — Outputs

output "asg_name" {
  description = "Auto Scaling Group name"
  value       = aws_autoscaling_group.msab.name
}

output "asg_arn" {
  description = "Auto Scaling Group ARN"
  value       = aws_autoscaling_group.msab.arn
}

output "launch_template_id" {
  description = "Launch Template ID"
  value       = aws_launch_template.msab.id
}

output "launch_template_version" {
  description = "Latest Launch Template version"
  value       = aws_launch_template.msab.latest_version
}

# --- Ticket 32 PART 4 ---------------------------------------------------

output "workers_per_instance" {
  description = "Expected mediasoup workers per instance for var.instance_type = vCPU - 1 (mirrors MSAB's own boot-time derivation, ticket 24; see the instance_vcpu_count/workers_per_instance locals). Consumed by modules/region to derive modules/cloudwatch's workers_below_expected alarm threshold as fleet_size × this value."
  value       = local.workers_per_instance
}

output "alarm_names" {
  description = "Names of every CloudWatch alarm this module declares (2 visibility-only connection alarms + 2 NLB/outage alarms) — consumed by the root alarm_names output for scripts/verify-alarms.mjs"
  value = [
    aws_cloudwatch_metric_alarm.high_connections.alarm_name,
    aws_cloudwatch_metric_alarm.low_connections.alarm_name,
    aws_cloudwatch_metric_alarm.zero_healthy_hosts.alarm_name,
    aws_cloudwatch_metric_alarm.refresh_unhealthy_sustained.alarm_name,
  ]
}

output "user_data_rendered" {
  description = "Plain-text rendered user-data script (the launch template carries it gzipped). For tests."
  value       = local.user_data_rendered
}
