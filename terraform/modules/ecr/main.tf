# =============================================================================
# ECR Module — Container Registry for MSAB Docker Images
# =============================================================================
# Provides a private ECR repository where GitHub Actions pushes built images
# and EC2 instances pull them during ASG instance refresh.
# =============================================================================

resource "aws_ecr_repository" "msab" {
  name                 = "${var.project_name}/msab"
  image_tag_mutability = "MUTABLE" # Allow :latest tag overwrites
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name    = "${var.project_name}-msab-ecr"
    Project = var.project_name
  }
}

# --- Lifecycle Policy: Keep last 10 tagged images, expire untagged after 1 day ---
resource "aws_ecr_lifecycle_policy" "msab" {
  repository = aws_ecr_repository.msab.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep last 10 tagged images"
        selection = {
          tagStatus   = "tagged"
          tagPrefixList = ["sha-"]
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
