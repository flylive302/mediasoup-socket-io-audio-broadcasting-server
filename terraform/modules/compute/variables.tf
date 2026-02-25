# Compute Module — Variables

variable "project_name" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "ssh_public_key_path" {
  type = string
}

variable "rtc_min_port" {
  type    = number
  default = 10000
}

variable "rtc_max_port" {
  type    = number
  default = 59999
}

variable "public_subnet_id" {
  type = string
}

variable "msab_security_group_id" {
  type = string
}

variable "github_repo" {
  type = string
}

variable "github_branch" {
  type = string
}

variable "app_port" {
  type = number
}

variable "redis_host" {
  type = string
}

variable "redis_port" {
  type = number
}

variable "redis_password" {
  type      = string
  sensitive = true
}

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

variable "audio_domain" {
  type = string
}

variable "cors_origins" {
  type    = string
  default = "https://flyliveapp.com,https://api.flyliveapp.com"
}

variable "laravel_api_url" {
  type    = string
  default = "https://api.flyliveapp.com"
}
