# SSM Module — Variables

variable "project_name" {
  type = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
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

# Rotation overlap — see the root variables.tf comment. "" (the default) means
# no rotation is in flight, and aws_ssm_parameter.jwt_secret_previous is not
# created: SSM rejects an empty SecureString value, and a parameter that does
# not exist is exactly what user-data.sh's fetch_ssm() turns into "".
variable "jwt_secret_previous" {
  description = "Rotation overlap for jwt_secret. Comma-separated. Empty outside a rotation."
  type        = string
  sensitive   = true
  default     = ""
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

# --- Per-instance DNS + TLS (ticket 39) ---

variable "manage_instance_dns" {
  description = "Whether to create the cloudflare-api-token SSM parameter instances use to self-register their DNS record at boot. Default false — no parameter, no API-callable token stored anywhere."
  type        = bool
  default     = false
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token, stored to SSM only when manage_instance_dns = true (see main.tf gating)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "instance_tls_certificate" {
  description = "PEM certificate (Cloudflare Origin CA) for the per-instance TLS terminator. Empty (default) = no SSM parameter created, terminator fails OPEN."
  type        = string
  sensitive   = true
  default     = ""
}

variable "instance_tls_private_key" {
  description = "PEM private key matching instance_tls_certificate."
  type        = string
  sensitive   = true
  default     = ""
}

variable "instance_tls_chain" {
  description = "Optional PEM certificate chain for instance_tls_certificate."
  type        = string
  sensitive   = true
  default     = ""
}
