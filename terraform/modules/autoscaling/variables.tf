# Auto Scaling Module — Variables

variable "region" {
  description = "AWS region identifier (e.g., ap-south-1) — passed to MSAB for cross-region routing"
  type        = string
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type (CPU-optimized recommended for MediaSoup)"
  type        = string
  default     = "c7i.xlarge"
}

variable "ssh_public_key_path" {
  description = "Path to SSH public key for EC2 access"
  type        = string
}

variable "instance_profile_name" {
  description = "IAM instance profile name for EC2 instances"
  type        = string
}

variable "msab_security_group_id" {
  description = "Security group ID for MSAB instances"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ASG placement"
  type        = list(string)
}

variable "target_group_arn" {
  description = "NLB target group ARN for instance registration"
  type        = string
}

# --- App Configuration ---

variable "github_repo" {
  description = "GitHub repository URL"
  type        = string
}

variable "github_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "master"
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

variable "redis_host" {
  description = "Redis/ElastiCache host"
  type        = string
}

variable "redis_port" {
  description = "Redis port"
  type        = number
  default     = 6379
}

variable "redis_password" {
  description = "Redis password"
  type        = string
  sensitive   = true
}

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

variable "audio_domain" {
  description = "Domain for the audio server"
  type        = string
}

variable "cors_origins" {
  description = "CORS origins for the app"
  type        = string
  default     = "https://flyliveapp.com,https://api.flyliveapp.com"
}

variable "laravel_api_url" {
  description = "Laravel API base URL"
  type        = string
  default     = "https://api.flyliveapp.com"
}

# --- Scaling Configuration ---

variable "min_instances" {
  description = "Minimum number of instances in the ASG"
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum number of instances in the ASG"
  type        = number
  default     = 3
}

variable "desired_instances" {
  description = "Desired number of instances in the ASG"
  type        = number
  default     = 1
}

variable "scale_up_threshold" {
  description = "ActiveConnections threshold to trigger scale up"
  type        = number
  default     = 500
}

variable "scale_down_threshold" {
  description = "ActiveConnections threshold to trigger scale down"
  type        = number
  default     = 100
}

variable "drain_timeout_seconds" {
  description = "Maximum time (seconds) to wait for drain before termination"
  type        = number
  default     = 900 # 15 minutes
}

variable "cascade_enabled" {
  description = "Enable SFU cross-region room cascading"
  type        = bool
  default     = false
}
