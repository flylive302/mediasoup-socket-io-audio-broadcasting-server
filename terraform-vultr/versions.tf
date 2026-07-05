# =============================================================================
# FlyLive Audio Server — Vultr Terraform: providers + remote state backend
# =============================================================================
# Slice A (vultr-migration/01): SKELETON ONLY. No resources are defined yet —
# `terraform plan` must come back with "No changes". The networking / compute /
# Valkey / load-balancer modules arrive in slice D (04-single-region-vultr-tracer).
#
# The AWS stack in ../terraform/ is KEPT as a dormant, redeployable backup
# (PRD "Architectural decisions"). This directory is the new substrate.
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.22"
    }
  }

  # -------------------------------------------------------------------------
  # Remote state on Vultr Object Storage (S3-compatible), mirroring the AWS S3
  # backend. The per-environment bucket + endpoint live in backend.hcl (which is
  # gitignored and account-specific) so staging and production never share state:
  #
  #   cp backend-staging.hcl.example backend.hcl        # or backend-prod.hcl.example
  #   # edit bucket + endpoints.s3 for your Object Storage subscription
  #   export AWS_ACCESS_KEY_ID=<object-storage S3 access key>
  #   export AWS_SECRET_ACCESS_KEY=<object-storage S3 secret key>
  #   terraform init -reconfigure -backend-config=backend.hcl
  #
  # NOTE — locking is intentionally NOT enabled here. Terraform's native S3
  # lock (`use_lockfile`) depends on conditional-write (If-None-Match) support,
  # which Vultr Object Storage (Ceph RGW) may not implement. With a zero-resource
  # skeleton and a single operator that is fine. Confirming/enabling locking is a
  # slice-08 (CI, multi-actor) gate — see 08-cicd-deploy-pipelines.md. If Vultr
  # cannot do conditional writes and locking is wanted, Terraform Cloud's free
  # tier (native locking, $0) is the clean fallback.
  # -------------------------------------------------------------------------
  backend "s3" {
    # bucket + endpoints.s3 come from -backend-config=backend.hcl (per-env)
    key    = "phase1/terraform.tfstate"
    region = "us-east-1" # dummy; Vultr ignores it, but the AWS SDK requires a value

    # Vultr Object Storage is S3-compatible but not AWS — skip all AWS-specific
    # validation/metadata calls, and use path-style addressing.
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
