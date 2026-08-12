# =============================================================================
# ECR Module — Container Registry for MSAB Docker Images
# =============================================================================
# Provides a private ECR repository where GitHub Actions pushes built images
# and EC2 instances pull them during ASG instance refresh.
# =============================================================================

resource "aws_ecr_repository" "msab" {
  name                 = "${var.project_name}/msab"
  image_tag_mutability = "IMMUTABLE" # Reject re-pushes of an existing tag — a sha-<commit8> tag must always resolve to one image
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
#  - NOT retroactive: only images pushed AFTER this applies are replicated. Under
#    IMMUTABLE (ticket 14) an existing tag can no longer be re-pushed to force
#    replication — the owner must push a NEW sha-<commit8> tag (a fresh CI build)
#    before Frankfurt's local-pull works.
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
#
# ticket 03 — why rule 1 does NOT orphan multi-arch images.
#
# A multi-arch build (`platforms: linux/amd64,linux/arm64`, and any default buildx
# build with provenance/SBOM attestations) publishes an OCI *image index*. Only the
# index carries the sha-<commit8> tag; its per-architecture child manifests are
# reported by `describe-images` with "tag": null. Rule 1 selects `tagStatus:
# untagged`, so on a naive reading it would expire those children ~1 day after the
# push and leave a dangling, unpullable tag — which IMMUTABLE would then forbid
# re-pushing.
#
# It does not, because ECR's lifecycle evaluator exempts them:
#   "If an image is referenced by a manifest list, it cannot be expired or archived
#    without the manifest list being deleted or archived first."
#   — https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html
#      (Lifecycle policy evaluation rules)
# Buildkit provenance/SBOM attestations are covered by the SAME exemption, not by the
# page's reference-artifact rule: buildx writes them as extra children *inside* the
# index (platform `unknown/unknown`), so the manifest list references them too. (The
# reference-artifact rule is about OCI referrers carrying a `subject` — a different
# mechanism that does not apply here.)
#
# ⚠️ Verified against the docs, NOT yet observed on this repository — the only image
# pushed so far was a single-manifest `--provenance=false --sbom=false` build, which
# has no untagged children to protect. `docs/issues-keep-watching/10-...` holds the
# 24 h pull check that closes that gap.
#
# ⛔ The invariant this rests on: no rule in this policy may select a *live tagged
# index by age*. Rule 1 is age-based but untagged-only (exempt above); rule 2 is
# tagged but count-based (intended retention: last 10 sha-* images). Adding a rule
# with `tagStatus: "any"`, or widening rule 1 to tagged images, deletes the index
# itself — and once the index is gone the exemption lifts and its children go too.
# `tests/ecr_lifecycle.tftest.hcl` fails the plan if that shape ever reappears.
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
