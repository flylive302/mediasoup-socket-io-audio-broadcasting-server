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

# Reverse-pipe failure rate.
# Counts in CloudWatch are cumulative-since-instance-startup; we use RATE()
# to convert to per-second deltas so a fresh failure burst isn't diluted by
# hours of good history. Alarm fires if recent failure ratio > 5% over
# 5 consecutive minutes; the IF() guard avoids noise when there are no
# attempts at all.
resource "aws_cloudwatch_metric_alarm" "reverse_pipe_failure_rate" {
  alarm_name          = "${var.project_name}-reverse-pipe-failure-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = 0.05
  alarm_description   = "ALERT: Reverse-pipe setup failure rate > 5% — edge speakers may be silent to origin/other-edge listeners. Check MSAB logs for 'setupReversePipe: failed' or '/internal/pipe/reverse-*' errors."
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

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
# CloudWatch Dashboard — MSAB Operations
# =============================================================================
# Single dashboard showing all custom metrics from the FlyLive/MSAB namespace.
# Uses SEARCH() to auto-discover instances — no hardcoded instance IDs.
# =============================================================================

resource "aws_cloudwatch_dashboard" "msab" {
  dashboard_name = "${var.project_name}-operations"

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
