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
