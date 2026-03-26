# Redis Module — Variables

variable "project_name" {
  type = string
}

variable "redis_node_type" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "redis_security_group_id" {
  type = string
}

variable "redis_auth_token" {
  description = "AUTH token for ElastiCache (must be 16-128 chars, no @, /, or quotes)"
  type        = string
  sensitive   = true
}
