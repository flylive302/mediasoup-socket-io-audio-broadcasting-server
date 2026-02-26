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
  description = "EC2 instance ID — leave empty when using ASG (ASG manages target registration)"
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ACM certificate ARN for TLS listener (empty = no TLS)"
  type        = string
  default     = ""
}
