# =============================================================================
# Networking Module — Firewall Group + Rules
# =============================================================================
# Vultr firewall groups are account-global objects (not VPC-scoped like AWS
# security groups) attached directly to an instance via firewall_group_id.
# No SSH ingress rule — shell access goes through Vultr's built-in web console
# (out-of-band, not network-dependent), mirroring the AWS stack's SSM-over-SSH
# choice.
# =============================================================================

terraform {
  required_providers {
    vultr = {
      source = "vultr/vultr"
    }
  }
}

resource "vultr_firewall_group" "msab" {
  description = "${var.project_name}-${var.environment}-${var.region}-msab"
}

# --- Application HTTP/WebSocket ---
resource "vultr_firewall_rule" "app_tcp" {
  firewall_group_id = vultr_firewall_group.msab.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = tostring(var.app_port)
  notes             = "App HTTP/WS"
}

# --- WebRTC UDP (includes SFU cascade ports — cross-region traffic comes from public IPs) ---
resource "vultr_firewall_rule" "rtc_udp" {
  firewall_group_id = vultr_firewall_group.msab.id
  protocol          = "udp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = "${var.rtc_min_port}:${var.rtc_max_port}"
  notes             = "WebRTC UDP + SFU cascade"
}

# --- WebRTC TCP fallback ---
resource "vultr_firewall_rule" "rtc_tcp" {
  firewall_group_id = vultr_firewall_group.msab.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = "${var.rtc_min_port}:${var.rtc_max_port}"
  notes             = "WebRTC TCP fallback"
}

# --- Private network (VPC) ---
# Vultr Load Balancers reach their backend instances over a shared private
# network — NOT the public/main IP. Without this, the LB's health check to the
# instance's app port can never succeed, so it has zero healthy nodes and never
# binds its frontend listener (confirmed live 2026-07-06: both :443 and :80
# time out despite correct forwarding rules + open firewall). Legacy vultr_vpc
# (DHCP) is used over vpc2 so the instance auto-configures its private NIC via
# cloud-init's network config, no guest-side netplan needed. Subnet is
# auto-assigned by Vultr when omitted.
resource "vultr_vpc" "msab" {
  region      = var.region
  description = "${var.project_name}-${var.environment}-${var.region}-vpc"
}
