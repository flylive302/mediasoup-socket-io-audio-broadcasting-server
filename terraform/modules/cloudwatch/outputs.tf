# CloudWatch Module — Outputs

output "alerts_topic_arn" {
  description = "SNS topic ARN for alert notifications"
  value       = aws_sns_topic.alerts.arn
}
