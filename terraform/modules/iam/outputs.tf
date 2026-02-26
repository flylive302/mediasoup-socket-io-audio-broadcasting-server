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
