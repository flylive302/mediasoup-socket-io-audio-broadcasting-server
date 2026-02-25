# =============================================================================
# Global Accelerator Module — Anycast geo-routing to regional NLBs
# =============================================================================

resource "aws_globalaccelerator_accelerator" "main" {
  name            = "${var.project_name}-ga"
  ip_address_type = "IPV4"
  enabled         = true

  tags = {
    Name    = "${var.project_name}-ga"
    Project = var.project_name
  }
}

# --- Listener: TLS passthrough on port 443 ---
resource "aws_globalaccelerator_listener" "tls" {
  accelerator_arn = aws_globalaccelerator_accelerator.main.id
  protocol        = "TCP"

  port_range {
    from_port = 443
    to_port   = 443
  }
}

# --- Endpoint Groups: one per region, pointing to regional NLB ---
resource "aws_globalaccelerator_endpoint_group" "regions" {
  for_each = var.regional_endpoints

  listener_arn                  = aws_globalaccelerator_listener.tls.id
  endpoint_group_region         = each.key
  health_check_port             = 443
  health_check_protocol         = "TCP"
  health_check_interval_seconds = 30
  threshold_count               = 3

  endpoint_configuration {
    endpoint_id                    = each.value.nlb_arn
    weight                         = 100
    client_ip_preservation_enabled = false # NLB doesn't support with GA
  }
}
