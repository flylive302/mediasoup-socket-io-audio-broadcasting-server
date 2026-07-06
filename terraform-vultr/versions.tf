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
  # Remote state on HCP Terraform (Terraform Cloud), free tier: $0, native state
  # locking, and CI-ready (slice H). Chosen over Vultr Object Storage because the
  # cheapest usable Object Storage tier is $18/mo for a few-KB state file, and its
  # conditional-write / locking support is unverified.
  #
  # The account-specific org name and the per-environment workspace stay OUT of
  # committed code (like backend.hcl did) — supplied via environment variables so
  # staging and production run byte-identical config against separate workspaces:
  #
  #   terraform login                                   # one-time: stores a user token
  #   export TF_CLOUD_ORGANIZATION=<your HCP org>
  #   export TF_WORKSPACE=msab-vultr-production         # this (first) account = prod; the future 2nd account = msab-vultr-staging
  #   terraform init
  #
  # Set each workspace's Execution Mode to **Local** (Org Settings → Default
  # Execution Mode → Local is the one-click way) so plan/apply run on your machine
  # with local secrets/tfvars — HCP only stores state + provides the lock.
  # -------------------------------------------------------------------------
  cloud {
    # organization comes from TF_CLOUD_ORGANIZATION
    workspaces {
      tags = ["msab-vultr"]
    }
  }
}
