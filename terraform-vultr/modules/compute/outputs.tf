output "public_ip" {
  value       = local.public_ip
  description = "The instance's announced public IPv4 (Terraform-known reserved IP, injected at boot). Enforcement of the public-IP contract lives on the ROOT module's `tracer_public_ip` output (a nested module output's own precondition isn't targetable by `terraform test`'s expect_failures)."
}

output "instance_id" {
  value = vultr_instance.main.id
}

# Exposed so the root module's output can carry its own precondition too —
# `terraform test`'s expect_failures can only target root-level checkable
# objects, not a nested module's own output precondition.
output "is_public_ipv4" {
  value = local.is_public_ipv4
}
