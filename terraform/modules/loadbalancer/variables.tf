# Load Balancer Module — Variables

variable "project_name" {
  type = string
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

variable "instance_id" {
  type = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN for TLS listener (empty = no TLS)"
  type        = string
  default     = ""
}
