# =============================================================================
# Load Balancer Module — TLS 443 -> app port, /health check
# =============================================================================
# auto_ssl_domain: Vultr terminates TLS and auto-issues/renews a Let's Encrypt
# cert for var.hostname via ACME HTTP-01, which requires that hostname's DNS
# to already resolve to this load balancer's IPv4 — a manual, two-pass step
# (create LB -> point Cloudflare DNS-only record at its ipv4 output -> Vultr
# issues the cert), same shape as the AWS stack's SNS-endpoint DNS gotcha.
# =============================================================================

terraform {
  required_providers {
    vultr = {
      source = "vultr/vultr"
    }
  }
}

resource "vultr_load_balancer" "main" {
  region              = var.region
  label               = "${var.project_name}-${var.environment}-${var.region}-lb"
  balancing_algorithm = "roundrobin"

  attached_instances = var.instance_ids

  auto_ssl_domain = var.hostname

  forwarding_rules {
    frontend_protocol = "https"
    frontend_port     = 443
    backend_protocol  = "http"
    backend_port      = var.app_port
  }

  health_check {
    protocol            = "http"
    path                = "/health"
    port                = var.app_port
    check_interval      = 15
    response_timeout    = 5
    unhealthy_threshold = 3
    healthy_threshold   = 2
  }
}
