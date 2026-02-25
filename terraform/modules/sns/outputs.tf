# SNS Module — Outputs

output "topic_arn" {
  description = "SNS topic ARN for Laravel to publish events"
  value       = aws_sns_topic.msab_events.arn
}

output "topic_name" {
  value = aws_sns_topic.msab_events.name
}
