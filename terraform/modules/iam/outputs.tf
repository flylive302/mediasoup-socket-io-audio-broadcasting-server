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

output "github_actions_access_key_id" {
  description = "Access key ID for the GitHub Actions deploy user → aws-production env secret AWS_ACCESS_KEY_ID"
  value       = aws_iam_access_key.github_actions.id
}

output "github_actions_secret_access_key" {
  description = "Secret access key for the GitHub Actions deploy user → aws-production env secret AWS_SECRET_ACCESS_KEY"
  value       = aws_iam_access_key.github_actions.secret
  sensitive   = true
}
