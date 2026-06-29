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

variable "instance_architecture" {
  description = <<-EOT
    CPU architecture for the AMI + container image: "amd64" (x86_64, default) or "arm64" (Graviton).
    Must match the instance_type family: c7i/c7g pairs vs c8g (arm64). The default keeps the exact
    amd64 Ubuntu AMI used historically — do NOT flip to arm64 in prod until a multi-arch MSAB image
    is published and validated on staging (realtime-06 HITL gate).
  EOT
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["amd64", "arm64"], var.instance_architecture)
    error_message = "instance_architecture must be \"amd64\" or \"arm64\"."
  }
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

variable "ecr_repo_url" {
  description = "ECR repository URL for the MSAB Docker image"
  type        = string
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
  default     = "https://flyliveapp.com,https://app.flyliveapp.com"
}

variable "laravel_api_url" {
  description = "Laravel API base URL"
  type        = string
  default     = "https://app.flyliveapp.com"
}

# --- Scaling Configuration ---

variable "min_instances" {
  description = "Minimum number of instances in the ASG"
  type        = number
  default     = 2
}

variable "max_instances" {
  description = "Maximum number of instances in the ASG. Raised 15→50 for 50k-user headroom (realtime-06). NOTE: 50×instance_type vCPU/region must fit the account's On-Demand Standard vCPU quota — confirm before relying on the ceiling."
  type        = number
  default     = 50
}

variable "desired_instances" {
  description = "Desired number of instances in the ASG"
  type        = number
  default     = 2
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
  # TIER0 (F-87): apply during ops window — see plan.
  # Was 900s. MSAB's SIGTERM drain ceiling is 120s (F-5); a 900s heartbeat
  # stranded a terminating instance for ~14m45s of paid-but-idle compute per
  # scale-in/deploy. 150s = 120s drain + 30s margin. Further optimization
  # (remove the residual wait entirely): have MSAB's drain-complete path call
  # `aws autoscaling complete-lifecycle-action` — tracked as an MSAB-runtime
  # follow-up, out of scope for this tf-only pass.
  default = 150
}

variable "cascade_enabled" {
  description = "Enable SFU cross-region room cascading"
  type        = bool
  default     = true
}

variable "instance_type_overrides" {
  description = "Ordered list of fallback instance types for mixed instances policy. When non-empty, the ASG uses a prioritized allocation strategy to try each type in order. Leave empty to use only the primary instance_type from the launch template."
  type        = list(string)
  default     = []
}

variable "cloudflare_turn_api_key" {
  description = "Cloudflare Realtime TURN API bearer token for dynamic credential generation"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_turn_key_id" {
  description = "Cloudflare Realtime TURN key ID"
  type        = string
  default     = ""
}

# realtime-08: interactive↔broadcast flip thresholds (Listener count, hysteresis).
# Default 1500/1000; lower in tfvars to smoke-test the broadcast tier on a region.
variable "room_broadcast_threshold_up" {
  description = "Listener count at/above which a Room flips to broadcast mode"
  type        = number
  default     = 1500
}

variable "room_broadcast_threshold_down" {
  description = "Listener count at/below which a Room flips back to interactive mode"
  type        = number
  default     = 1000
}

# realtime-09: broadcast HLS tier. R2 access keys are SSM secrets (see iam module);
# these are the non-sensitive values templated into the container .env. Disabled by
# default — when true the MSAB config refine requires all HLS_R2_* + base URL set.
variable "broadcast_hls_enabled" {
  description = "Enable the LL-HLS broadcast publish tier (realtime-09)"
  type        = bool
  default     = false
}

variable "hls_r2_endpoint" {
  description = "R2 S3 API endpoint for HLS publishing, e.g. https://<acct>.r2.cloudflarestorage.com"
  type        = string
  default     = ""
}

variable "hls_r2_bucket" {
  description = "R2 bucket for live HLS artifacts (e.g. flylive-live-hls)"
  type        = string
  default     = ""
}

variable "hls_public_base_url" {
  description = "Public CDN base for HLS playback (no trailing slash), e.g. https://live.flyliveapp.com"
  type        = string
  default     = ""
}

variable "target_group_arn_suffix" {
  description = "ARN suffix of the NLB target group (for CloudWatch dimensions)"
  type        = string
  default     = ""
}

variable "load_balancer_arn_suffix" {
  description = "ARN suffix of the NLB (for CloudWatch dimensions)"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Docker image tag to deploy. Pin to a git-SHA tag (e.g., sha-abc1234) in production. Using 'latest' risks mixed cluster versions during scale-out events."
  type        = string
  default     = "latest"

  validation {
    condition     = var.image_tag != ""
    error_message = "image_tag must not be empty."
  }
}

variable "alarm_notification_topic_arn" {
  description = "SNS topic ARN for alarm notifications (zero healthy hosts, etc.)"
  type        = string
  default     = ""
}

# --- MSAB Application Config ---

variable "jwt_max_age_seconds" {
  description = "Maximum JWT age in seconds — written to boot .env"
  type        = number
  default     = 2592000 # 30 days
}

variable "laravel_api_timeout_ms" {
  description = "Timeout for MSAB → Laravel API calls in milliseconds"
  type        = number
  default     = 10000
}

variable "ice_stun_urls" {
  description = "Comma-separated STUN server URLs for WebRTC NAT traversal"
  type        = string
  default     = "stun:stun.cloudflare.com:3478,stun:stun.cloudflare.com:53"
}
