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

output "pull_resource_arn" {
  description = <<-DESC
    Region-wildcarded repository ARN for the instance ecr-pull grant (aws-production/04).

    Plan-known on purpose: built from the CONFIGURED repository name + account id
    rather than aws_ecr_repository.msab.arn, so the IAM policy renders at plan
    instead of waiting on the repository resource.

    The `*` region segment is deliberate, not laziness. Images are replicated into
    every enabled region (aws_ecr_replication_configuration above) and instances
    pull from their LOCAL replica — modules/autoscaling/user-data.sh rewrites the
    registry hostname to the instance's own region. A home-region-only ARN would
    therefore deny pulls in Frankfurt/Singapore the moment either is enabled.
    Account id and repository name stay pinned, so this matches this project's
    replicas and nothing else.
  DESC
  value       = "arn:aws:ecr:*:${data.aws_caller_identity.current.account_id}:repository/${aws_ecr_repository.msab.name}"
}
