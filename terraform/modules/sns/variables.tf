# SNS Module — Variables

variable "project_name" {
  type = string
}

variable "msab_endpoint_urls" {
  description = "List of regional MSAB /api/events HTTPS endpoints to subscribe"
  type        = list(string)
}

variable "aws_account_id" {
  description = "AWS account ID for SNS topic policy"
  type        = string
}
