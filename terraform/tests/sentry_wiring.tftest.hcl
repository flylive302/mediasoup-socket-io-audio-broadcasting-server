# =============================================================================
# env-diff finding 2026-08-18 — Sentry reaches the instance env, or it stays
# off with no half-configured residue
# =============================================================================
# The Vultr fleet reported to Sentry; the AWS fleet rendered no SENTRY_* at all
# — an observability blackout that would have started at the cutover flip.
# Same defect class as EVENT_QUEUE_URL (see event_queue_wiring.tftest.hcl's
# header): a plan is clean whether or not a variable was ever plumbed, so these
# assert on the RENDERED user-data.
#
# MODULE-SCOPED for the same provider-mocking reason as that file. After adding
# this file, re-run `terraform init -backend=false` before `terraform test`.
# =============================================================================

mock_provider "aws" {}

variables {
  # Required (no-default) module inputs — dummies, never applied.
  region                 = "ap-south-1"
  project_name           = "flylive-audio"
  environment            = "production"
  ssh_public_key_path    = "./tests/fixtures/id_ed25519.pub"
  instance_profile_name  = "mock-profile"
  msab_security_group_id = "sg-mock"
  public_subnet_ids      = ["subnet-mock-a", "subnet-mock-b"]
  target_group_arn       = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:targetgroup/mock/abc"
  ecr_repo_url           = "111111111111.dkr.ecr.ap-south-1.amazonaws.com/flylive-audio/msab"
  redis_host             = "mock-redis"
  redis_cache_host       = "mock-redis-cache"
  image_tag              = "sha-deadbeef"
}

# -----------------------------------------------------------------------------
# ARMED: a DSN passed in renders all three SENTRY_* lines, and the release is
# the image tag — the sha the sourcemaps were uploaded under. The `\n…\n`
# anchors are load-bearing: the comment above the block names SENTRY_DSN in
# prose, so a substring match could pass on the comment alone.
# -----------------------------------------------------------------------------
run "sentry_dsn_reaches_the_instance_env" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    sentry_dsn = "https://examplekey@o000000.ingest.sentry.io/0000000"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nSENTRY_DSN=${var.sentry_dsn}\n")
    error_message = "SENTRY_DSN must be rendered into the instance env verbatim — without it MSAB errors on the AWS fleet reach nothing but CloudWatch"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nSENTRY_RELEASE=${var.image_tag}\n")
    error_message = "SENTRY_RELEASE must be the image tag byte-identical to the sourcemap upload — any other value silently stops sourcemaps from applying"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nSENTRY_ENVIRONMENT=production\n")
    error_message = "SENTRY_ENVIRONMENT must be the module's environment so staging noise can never pollute the production Sentry stream"
  }
}

# -----------------------------------------------------------------------------
# INERT: the default renders NO SENTRY_* key at all — a present-but-empty key
# reads as configured to anyone grepping the instance env.
# -----------------------------------------------------------------------------
run "no_dsn_renders_no_sentry_keys_at_all" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.sentry_dsn == ""
    error_message = "sentry_dsn must default to empty — Sentry ships inert and is armed only by an explicit tfvars value"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "\nSENTRY_")
    error_message = "With no DSN configured the env file must carry no SENTRY_* key at all"
  }
}
