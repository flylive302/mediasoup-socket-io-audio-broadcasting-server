# =============================================================================
# CloudWatch Module — Operational Alarms
# =============================================================================
# Alarms for operational visibility (not scaling — those are in autoscaling module).
# These alarms notify via SNS for pager/alert integration.
# =============================================================================

# --- SNS Topic for Alerts ---
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"

  tags = {
    Project = var.project_name
  }
}

# --- Alarm: High Connection Count ---
resource "aws_cloudwatch_metric_alarm" "high_connections" {
  alarm_name          = "${var.project_name}-high-connections-alert"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "ActiveConnections"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.connection_alert_threshold
  alarm_description   = "ALERT: ActiveConnections > ${var.connection_alert_threshold} for 5 minutes"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  dimensions = {}
}

# --- Alarm: No Healthy Workers ---
resource "aws_cloudwatch_metric_alarm" "no_workers" {
  alarm_name          = "${var.project_name}-no-workers-alert"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "WorkerCount"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "CRITICAL: No healthy MediaSoup workers for 2 minutes"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  dimensions = {}
}

# --- Alarm: High CPU ---
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  alarm_name          = "${var.project_name}-high-cpu-alert"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "WorkerCPU"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Average"
  threshold           = var.cpu_alert_threshold
  alarm_description   = "WARNING: Average CPU > ${var.cpu_alert_threshold}% for 5 minutes"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  dimensions = {}
}
