# =============================================================================
# Outputs
# =============================================================================

output "tracer_public_ip" {
  description = "The tracer instance's announced public IPv4 (Terraform-known reserved IP)."
  value       = module.compute.public_ip

  # Redundant with modules/compute's own output precondition (which already
  # fails the plan/apply) — repeated here so `terraform test`'s
  # expect_failures can target a root-level checkable object; nested module
  # outputs aren't addressable for that purpose.
  precondition {
    condition     = module.compute.is_public_ipv4
    error_message = "Tracer public IP is not a well-formed public IPv4 address (empty/loopback/private/link-local)."
  }
}

output "tracer_lb_ipv4" {
  description = "The tracer load balancer's public IPv4 — point tracer_lb_hostname's Cloudflare DNS record (PROXIED / orange-cloud) here."
  value       = module.loadbalancer.ipv4
}

output "tracer_lb_hostname" {
  description = "The hostname the ssl cert (Cloudflare Origin CA) is issued for, covered by the *.audio.flyliveapp.com wildcard SAN."
  value       = var.tracer_hostname
}

output "tracer_valkey_host" {
  description = "The shared per-region Valkey endpoint hostname."
  value       = module.valkey.host
}
