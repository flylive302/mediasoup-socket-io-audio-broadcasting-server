# Queues Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "alerts_topic_arn" {
  description = "SNS topic ARN for alarm notifications (modules/alerting, global). Empty (default) keeps the alarms visibility-only — no alarm_actions/ok_actions wired."
  type        = string
  default     = ""
}
