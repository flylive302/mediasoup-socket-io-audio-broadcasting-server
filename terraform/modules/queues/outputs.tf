# Queues Module — Outputs

output "queue_arn" {
  description = "ARN of the main msab-events FIFO queue"
  value       = aws_sqs_queue.msab_events.arn
}

output "queue_url" {
  description = "URL of the main msab-events FIFO queue (consumer/producer config)"
  value       = aws_sqs_queue.msab_events.id
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue (source-arn for aws sqs start-message-move-task)"
  value       = aws_sqs_queue.msab_events_dlq.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue (for operator inspection)"
  value       = aws_sqs_queue.msab_events_dlq.id
}

output "alarm_names" {
  description = "Names of every CloudWatch alarm this module declares (depth, age, DLQ presence) — consumed by the root alarm_names output for scripts/verify-alarms.mjs"
  value = [
    aws_cloudwatch_metric_alarm.queue_depth.alarm_name,
    aws_cloudwatch_metric_alarm.queue_age.alarm_name,
    aws_cloudwatch_metric_alarm.dlq_messages.alarm_name,
  ]
}
