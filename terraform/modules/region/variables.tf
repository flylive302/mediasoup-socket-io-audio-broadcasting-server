# Region composite module — variables
# One instance of this module = one complete MSAB region (networking, redis,
# ssl, loadbalancer, ssm, cloudwatch, autoscaling).

variable "region_name" {
  description = "Short region name used in tags/keys (mumbai | frankfurt | singapore)"
  type        = string
}

variable "aws_region" {
  description = "AWS region id this module's provider points at (e.g. ap-south-1)"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR for this region+environment — from the ticket-11 allocation table; one-way once applied"
  type        = string
}

variable "project_name" { type = string }
variable "environment" { type = string }
variable "app_port" { type = number }
variable "rtc_min_port" { type = number }
variable "rtc_max_port" { type = number }
variable "cascade_ports_open" { type = bool }
variable "cascade_enabled" { type = bool }

variable "redis_node_type" { type = string }
variable "redis_auth_token" {
  type      = string
  sensitive = true
}

variable "audio_domain" { type = string }
variable "instance_type" { type = string }
variable "instance_architecture" { type = string }
variable "ssh_public_key_path" { type = string }
variable "instance_profile_name" { type = string }
variable "ecr_repo_url" { type = string }

variable "laravel_internal_key" {
  type      = string
  sensitive = true
}
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "session_secret" {
  type      = string
  sensitive = true
}
variable "cloudflare_turn_api_key" {
  type      = string
  sensitive = true
}
variable "cloudflare_turn_key_id" { type = string }

variable "cors_origins" { type = string }
variable "laravel_api_url" { type = string }
variable "jwt_max_age_seconds" { type = number }
variable "laravel_api_timeout_ms" { type = number }
variable "ice_stun_urls" { type = string }

variable "room_broadcast_threshold_up" { type = number }
variable "room_broadcast_threshold_down" { type = number }

variable "broadcast_hls_enabled" { type = bool }
variable "hls_r2_endpoint" { type = string }
variable "hls_r2_bucket" { type = string }
variable "hls_public_base_url" { type = string }
variable "hls_r2_access_key_id" {
  type      = string
  sensitive = true
}
variable "hls_r2_secret_access_key" {
  type      = string
  sensitive = true
}

variable "min_instances" { type = number }
variable "desired_instances" { type = number }
variable "max_instances" { type = number }
