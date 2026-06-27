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

# --- Cross-region replication (realtime-06) ---
# Replicate every push of this account's ECR images into each consuming region so
# instances pull from their LOCAL registry instead of cross-region from ap-south-1
# (removes the Mumbai-ECR latency/cost/SPOF dependency for Frankfurt scaling).
#
# Caveats baked into the runbook:
#  - NOT retroactive: only images pushed AFTER this applies are replicated. The
#    owner must re-push (or re-tag :latest) before Frankfurt's local-pull works.
#  - Lifecycle policies do NOT replicate — the destination repo is auto-created by
#    ECR and accumulates images; prune it manually/separately if it grows.
resource "aws_ecr_replication_configuration" "msab" {
  count = length(var.replication_destination_regions) > 0 ? 1 : 0

  replication_configuration {
    rule {
      dynamic "destination" {
        for_each = toset(var.replication_destination_regions)
        content {
          region      = destination.value
          registry_id = data.aws_caller_identity.current.account_id
        }
      }

      repository_filter {
        filter      = "${var.project_name}/"
        filter_type = "PREFIX_MATCH"
      }
    }
  }
}

data "aws_caller_identity" "current" {}

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
          tagStatus     = "tagged"
          tagPrefixList = ["sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
