# Alerting Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "alert_email" {
  description = "Email address to subscribe to the alerts topic. Empty (default) ships alerting inert — the topic exists but has no subscriber, so nothing can page anyone by accident."
  type        = string
  default     = ""
}
