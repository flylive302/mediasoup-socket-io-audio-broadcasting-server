# Load Balancer Module — Variables

variable "project_name" {
  type = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "app_port" {
  type = number
}

variable "certificate_arn" {
  description = "ACM certificate ARN for TLS listener (empty = no TLS)"
  type        = string
  default     = ""
}
