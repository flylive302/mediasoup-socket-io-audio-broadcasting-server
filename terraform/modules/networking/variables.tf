# Networking Module — Variables

variable "project_name" {
  type = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR — from the ticket-11 allocation table (docs/issues/aws-platform-build/11-CIDR-ALLOCATION.md). Non-overlapping per region+environment; ONE-WAY once addresses are in use."
  type        = string
}

variable "app_port" {
  type = number
}

variable "rtc_min_port" {
  description = "First WebRTC port. The app binds ONE shared port per mediasoup worker (rtc_min_port + worker index, UDP+TCP) via WebRtcServer — NOT one port per user."
  type        = number
}

variable "rtc_max_port" {
  description = "Last WebRTC port opened in the firewall. Sized as headroom over worker count (workers = vCPU - 1), not per-connection."
  type        = number
}

variable "cascade_ports_open" {
  description = <<-EOT
    Open the SFU cascade relay UDP range (40000-49999) to the internet.
    Required while CASCADE_ENABLED=true: cascade pipes audio between instances
    (including two instances in the SAME region when a room spans them) using
    instance PUBLIC IPs, so the traffic arrives internet-sourced and cannot be
    security-group-referenced. Close only once room affinity (affinity epic
    07/09/11) guarantees single-instance rooms AND multi-region is off.
  EOT
  type        = bool
}

variable "cascade_relay_min_port" {
  description = "Cascade plainTransport range start — must match PLAIN_TRANSPORT_MIN_PORT in src/domains/media/pipe-manager.ts"
  type        = number
  default     = 40000
}

variable "cascade_relay_max_port" {
  description = "Cascade plainTransport range end — must match PLAIN_TRANSPORT_MAX_PORT in src/domains/media/pipe-manager.ts"
  type        = number
  default     = 49999
}
