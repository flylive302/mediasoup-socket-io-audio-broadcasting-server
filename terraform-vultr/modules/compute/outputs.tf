output "public_ips" {
  value       = local.public_ips
  description = "Every fleet instance's announced public IPv4 (Terraform-known reserved IPs, injected at boot). Enforcement of the public-IP contract lives on the ROOT module's `tracer_public_ips` output (a nested module output's own precondition isn't targetable by `terraform test`'s expect_failures)."
}

output "instance_ids" {
  value       = vultr_instance.main[*].id
  description = "All fleet instance IDs — wired straight into the load balancer's attached_instances."
}

output "instance_hostnames" {
  value       = vultr_instance.main[*].hostname
  description = "Every fleet instance's rendered hostname (`$${project_name}-$${environment}-$${region}-NN`), same order as public_ips (index-aligned). This is the ONLY instance identity in the system (also the boot-time INSTANCE_ID_OVERRIDE basis) — per-instance DNS (issue 16) derives its record name from this, not a new identifier."
}

# Exposed so the root module's output can carry its own precondition too —
# `terraform test`'s expect_failures can only target root-level checkable
# objects, not a nested module's own output precondition.
output "all_public_ipv4" {
  value       = local.all_public_ipv4
  description = "True only if EVERY fleet instance announces a well-formed public IPv4."
}
