# SSM Module — Variables

variable "project_name" {
  type = string
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
