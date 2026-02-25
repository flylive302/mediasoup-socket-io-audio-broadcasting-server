# =============================================================================
# SSL Module — ACM Certificate
# =============================================================================

# --- Request Certificate ---
resource "aws_acm_certificate" "main" {
  domain_name       = var.audio_domain
  validation_method = "DNS"

  tags = {
    Name    = "${var.project_name}-cert"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}
