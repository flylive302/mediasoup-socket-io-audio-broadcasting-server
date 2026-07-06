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
