# =============================================================================
# Outputs — per-region maps (slice 06)
# =============================================================================
# Every module is now keyed by region (for_each over var.fleet_regions), so each
# output is a `region code -> value` map. The public-IP contract, previously a
# single-region precondition, now spans EVERY instance in EVERY region.
# =============================================================================

output "region_public_ips" {
  description = "region code -> that region's fleet instance announced public IPv4s (Terraform-known reserved IPs)."
  value       = { for r, m in module.compute : r => m.public_ips }

  # Fleet-wide, ALL regions: fails the plan/apply if ANY instance in ANY region
  # announces a non-public IP. Repeated at root level (each compute module already
  # guards its own region) so `terraform test`'s expect_failures has a root-level
  # checkable object to target — nested module output preconditions aren't addressable.
  precondition {
    condition     = alltrue([for m in values(module.compute) : m.all_public_ipv4])
    error_message = "A fleet instance's public IP (in some region) is not a well-formed public IPv4 address (empty/loopback/private/link-local)."
  }
}

output "region_lb_ipv4" {
  description = "region code -> that region's load balancer public IPv4. Point each region's Cloudflare DNS record (PROXIED / orange-cloud) at its entry."
  value       = { for r, m in module.loadbalancer : r => m.ipv4 }
}

output "region_lb_hostnames" {
  description = "region code -> the hostname its LB (and the TLS cert SAN) is issued for, and that config/realtime.php resolves Rooms to."
  value       = local.region_hostnames
}

output "region_valkey_hosts" {
  description = "region code -> that region's shared Valkey endpoint hostname."
  value       = { for r, m in module.valkey : r => m.host }
}
