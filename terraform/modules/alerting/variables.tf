# Alerting Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "alert_email" {
  description = "Email address to subscribe to the alerts topic. Empty (default) ships alerting inert — the topic exists but has no subscriber, so nothing can page anyone by accident."
  type        = string
  default     = ""
}
