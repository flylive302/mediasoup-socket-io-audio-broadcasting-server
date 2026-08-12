# Queues Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "alerts_topic_arn" {
  description = "SNS topic ARN for alarm notifications (modules/alerting, global). Empty (default) keeps the alarms visibility-only — no alarm_actions/ok_actions wired."
  type        = string
  default     = ""
}
