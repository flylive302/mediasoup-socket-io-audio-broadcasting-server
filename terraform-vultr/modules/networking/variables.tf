variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  description = "Vultr region code this firewall group applies to (informational — firewall groups are account-global, not region-scoped, but rules mirror one region's fleet)."
  type        = string
}

variable "app_port" {
  type = number
}

variable "rtc_min_port" {
  type = number
}

variable "rtc_max_port" {
  type = number
}
