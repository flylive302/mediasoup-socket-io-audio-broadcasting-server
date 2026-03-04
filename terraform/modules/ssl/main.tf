# =============================================================================
# SSL Module — ACM Certificate
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# --- Request Certificate (covers both base domain and regional subdomains) ---
resource "aws_acm_certificate" "main" {
  domain_name               = var.audio_domain
  subject_alternative_names = ["*.${var.audio_domain}"]
  validation_method         = "DNS"

  tags = {
    Name    = "${var.project_name}-cert"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Wait for DNS validation to complete ---
# This blocks downstream resources (NLB listener) until ACM issues the cert.
resource "aws_acm_certificate_validation" "main" {
  certificate_arn = aws_acm_certificate.main.arn

  # Timeout after 10 minutes (DNS propagation + ACM validation)
  timeouts {
    create = "10m"
  }
}
