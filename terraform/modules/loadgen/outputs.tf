# Loadgen Module — Outputs
#
# Every output that reads a count-gated resource uses try(...) so it resolves
# to null instead of an "index out of range" error when the module is
# disabled (var.enabled = false, or environment != "staging") — root/outputs.tf
# and the operator both read these after a `terraform apply` regardless of
# whether the box is currently standing up or torn down.

output "instance_id" {
  description = "EC2 instance id of the loadgen box. null when disabled."
  value       = try(aws_instance.loadgen[0].id, null)
}

output "public_ip" {
  description = "Public IP of the loadgen box — what the operator SSMs into and what docs/runbooks/msab-loadgen-campaign.md calls $LOADGEN_IP. null when disabled."
  value       = try(aws_instance.loadgen[0].public_ip, null)
}

output "security_group_id" {
  description = "Security group id of the loadgen box. Consumed by modules/networking (via modules/region) to open the msab security group's port-9100 ingress FROM this SG — never a CIDR. null when disabled, which is also what makes that ingress rule disappear on teardown (docs/runbooks/msab-loadgen-campaign.md step 10's teardown gate)."
  value       = try(aws_security_group.loadgen[0].id, null)
}

# Plain-text rendered user-data script (the instance carries it gzipped). For
# tests — mirrors modules/autoscaling/outputs.tf's identical output/reason.
# Not try()-wrapped: the underlying local is computed unconditionally (see the
# comment on locals.user_data_rendered in main.tf), so it never indexes into a
# count-gated resource and has nothing for try() to catch.
output "user_data_rendered" {
  description = "Plain-text rendered user-data script (the instance carries it gzipped). For tests."
  value       = local.user_data_rendered
}
