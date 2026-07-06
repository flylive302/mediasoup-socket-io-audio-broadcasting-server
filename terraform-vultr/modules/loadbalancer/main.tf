# =============================================================================
# Load Balancer Module — TLS 443 -> app port, /health check
# =============================================================================
# TLS is supplied via a bring-your-own certificate (Cloudflare Origin CA), NOT
# Vultr's auto_ssl_domain — that requires the domain to be a Vultr-hosted DNS
# zone in this account, which would conflict with keeping Cloudflare as DNS
# authority (frontend/TURN/R2 all depend on it staying there). Confirmed live:
# auto_ssl_domain failed apply with "Domain not found for account: <domain>"
# because `GET /v2/domains` on this account is empty — Vultr checks its OWN
# DNS zone list, not whether the hostname resolves here from anywhere else.
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

  ssl {
    private_key = var.ssl_private_key
    certificate = var.ssl_certificate
    chain       = var.ssl_chain != "" ? var.ssl_chain : null
  }

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
