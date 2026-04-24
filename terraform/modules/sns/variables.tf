# SNS Module — Variables

variable "project_name" {
  type = string
}

variable "msab_endpoint_urls" {
  description = "Map of region-name => MSAB /api/events HTTPS endpoint. Keys must be static (known at plan time); values may contain apply-time NLB DNS names."
  type        = map(string)
}

variable "aws_account_id" {
  description = "AWS account ID for SNS topic policy"
  type        = string
}

variable "laravel_internal_key" {
  description = "Internal API key — appended to endpoint URLs as ?key= for SNS authentication"
  type        = string
  sensitive   = true
}
