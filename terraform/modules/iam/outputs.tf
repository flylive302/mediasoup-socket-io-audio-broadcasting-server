# IAM Module — Outputs

output "instance_profile_name" {
  description = "IAM instance profile name for EC2/ASG"
  value       = aws_iam_instance_profile.msab.name
}

output "instance_profile_arn" {
  description = "IAM instance profile ARN"
  value       = aws_iam_instance_profile.msab.arn
}

output "role_arn" {
  description = "IAM role ARN"
  value       = aws_iam_role.msab.arn
}

output "role_name" {
  description = "IAM role name (ticket 16: modules/ssm attaches a per-region kms:Decrypt grant to this role, scoped to that region's CMK — colocated there rather than here to avoid a module dependency cycle, since modules/region already depends on this module for instance_profile_name)"
  value       = aws_iam_role.msab.name
}

output "github_actions_role_arn" {
  description = "ARN of the OIDC-federated GitHub Actions deploy role → aws-production env variable AWS_DEPLOY_ROLE_ARN (role ARNs are not secrets)"
  value       = aws_iam_role.github_actions.arn
}

# Ticket 04: policy-JSON outputs exist only so the offline test suite can
# assert on the two tightened grants from a ROOT-level run. A module-scoped
# `module { source = "./modules/iam" }` run block re-types the test suite's
# unaliased "cloudflare" mock_provider for the whole `terraform test`
# invocation (this module never references cloudflare, so nothing anchors it
# to the root's cloudflare/cloudflare source) and breaks every other file
# that expects it — see the trap documented in
# tests/redis_store_split.tftest.hcl. Nested-module resources are not
# otherwise addressable from a root-level run's asserts.
output "ecr_pull_policy" {
  description = "Rendered JSON of the ecr_pull role policy (test seam, ticket 04)"
  value       = aws_iam_role_policy.ecr_pull.policy
}

# The two SendCommand statements shared by the permissions boundary AND the ASG
# refresh policy. Exposed as the local rather than either rendered policy: both
# of those embed ARNs that are unknown at plan, and this suite runs `plan` only.
# One seam covers both consumers because both reference this same local — see
# modules/iam/main.tf `local.ssm_send_command_statements`.
output "ssm_send_command_statements" {
  description = "SendCommand statement pair — [0] ungated document, [1] tag-gated instances (test seam, aws-production/04)"
  value       = local.ssm_send_command_statements
}
