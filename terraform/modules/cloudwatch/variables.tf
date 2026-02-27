# CloudWatch Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "aws_region" {
  description = "AWS region for dashboard metric queries"
  type        = string
}

variable "connection_alert_threshold" {
  description = "ActiveConnections threshold for alert (not scaling)"
  type        = number
  default     = 800
}

variable "cpu_alert_threshold" {
  description = "WorkerCPU percentage threshold for alert"
  type        = number
  default     = 85
}
