# Alerting Module — Outputs

output "alerts_topic_arn" {
  description = "SNS topic ARN for alert notifications — the single global alerting inbox"
  value       = aws_sns_topic.alerts.arn
}
