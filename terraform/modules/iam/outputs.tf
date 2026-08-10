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
