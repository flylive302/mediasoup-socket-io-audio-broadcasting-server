# =============================================================================
# FlyLive Audio Server — Terraform Variables
# =============================================================================

variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
  default     = "flylive-audio"
}

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "EC2 instance type (CPU-optimized recommended for MediaSoup)"
  type        = string
  default     = "c7i.xlarge"
}

variable "ssh_public_key_path" {
  description = "Path to SSH public key for EC2 access"
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.micro"
}

variable "app_port" {
  description = "Application HTTP/WebSocket port"
  type        = number
  default     = 3030
}

variable "rtc_min_port" {
  description = "Minimum WebRTC UDP port"
  type        = number
  default     = 10000
}

variable "rtc_max_port" {
  description = "Maximum WebRTC UDP port"
  type        = number
  default     = 59999
}

variable "audio_domain" {
  description = "Domain for the audio server"
  type        = string
  default     = "audio.flyliveapp.com"
}

# Secrets — passed via environment variables (TF_VAR_*) or terraform.tfvars
variable "laravel_internal_key" {
  description = "Shared secret key for Laravel API authentication"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT secret shared with Laravel backend"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Express session secret"
  type        = string
  sensitive   = true
  default     = ""
}

# Cloudflare Realtime TURN (for WebRTC relay)
variable "cloudflare_turn_api_key" {
  description = "Cloudflare Realtime TURN API bearer token — server fetches short-lived credentials dynamically"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_turn_key_id" {
  description = "Cloudflare Realtime TURN key ID (the short hex in the API URL)"
  type        = string
  default     = ""
}
