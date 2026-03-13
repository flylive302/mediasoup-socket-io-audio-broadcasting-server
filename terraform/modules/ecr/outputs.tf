# ECR Module — Outputs

output "repository_url" {
  description = "Full ECR repository URL (used by docker push/pull)"
  value       = aws_ecr_repository.msab.repository_url
}

output "repository_arn" {
  description = "ECR repository ARN (for IAM policies)"
  value       = aws_ecr_repository.msab.arn
}

output "registry_id" {
  description = "ECR registry ID (AWS account ID)"
  value       = aws_ecr_repository.msab.registry_id
}
