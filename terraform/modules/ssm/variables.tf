# SSM Module — Variables

variable "project_name" {
  type = string
}

variable "iam_role_name" {
  description = "Name of the shared EC2 instance IAM role (modules/iam) — the kms:Decrypt grant for this region's CMK is attached here"
  type        = string
}

variable "aws_region" {
  description = "AWS region this instance of the module runs in — used only to make the kms:Decrypt role-policy name unique per region (the IAM role is global, this module is regional)"
  type        = string
}

variable "jwt_secret" {
  description = "JWT secret shared with Laravel backend"
  type        = string
  sensitive   = true
}

variable "laravel_internal_key" {
  description = "Shared secret key for Laravel API authentication"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Express session secret"
  type        = string
  sensitive   = true
}

variable "cloudflare_turn_api_key" {
  description = "Cloudflare Realtime TURN API bearer token"
  type        = string
  sensitive   = true
}

variable "redis_auth_token" {
  description = "Redis AUTH token"
  type        = string
  sensitive   = true
}

# realtime-09 broadcast HLS R2 keys — only stored when the tier is enabled.
variable "broadcast_hls_enabled" {
  description = "Whether to create the broadcast HLS R2 SSM secrets"
  type        = bool
  default     = false
}

variable "hls_r2_access_key_id" {
  description = "R2 Object Read/Write access key id for HLS publishing"
  type        = string
  sensitive   = true
  default     = ""
}

variable "hls_r2_secret_access_key" {
  description = "R2 Object Read/Write secret access key for HLS publishing"
  type        = string
  sensitive   = true
  default     = ""
}
