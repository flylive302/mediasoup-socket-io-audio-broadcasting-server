# IAM Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "ecr_repository_arn" {
  description = "ARN of the MSAB ECR repository — scopes the GitHub Actions push policy"
  type        = string
}

variable "github_repository" {
  description = "GitHub org/repo whose Actions runs may assume the deploy role via OIDC (trust-policy sub claim)"
  type        = string
  default     = "flylive302/mediasoup-socket-io-audio-broadcasting-server"
}

variable "github_environment" {
  description = "GitHub deployment environment (Settings → Environments) whose jobs may assume the deploy role. Carries the required-reviewer gate, so only human-approved runs can deploy."
  type        = string
  default     = "aws-production"
}

variable "enable_event_queue_consume" {
  description = "Create the SQS consume policy on the MSAB role (ticket 25). Static flag — count cannot depend on the computed queue ARN."
  type        = bool
  default     = false
}

variable "event_queue_arn" {
  description = "ARN of the msab-events FIFO queue (ticket 25). Required when enable_event_queue_consume = true."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = <<-EOT
    CloudWatch Logs retention (days) for the MSAB log group (project_name/msab).
    Default 30 days: enough to debug a realtime-audio incident (rooms/seats,
    connection drops) after the fact, while bounding storage cost. Incidents
    older than a month are investigated from docs/metrics (dashboards,
    postmortems), not raw container logs — see docs/reference/hard-won-gotchas.md.
  EOT
  type        = number
  default     = 30
}
