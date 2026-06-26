# IAM Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "ecr_repository_arn" {
  description = "ARN of the MSAB ECR repository — scopes the GitHub Actions push policy"
  type        = string
}
