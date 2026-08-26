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

# -----------------------------------------------------------------------------
# ticket 39 (AWS port of MSAB issues 16/36) — per-instance DNS + TLS rendered
# into user-data.sh. Asserted on the RENDERED SCRIPT, same reasoning as the
# Sentry runs above: a plan alone can't distinguish "wired but inert" from
# "never wired", and AC #1/#2 require the DNS code not even exist in the
# script when manage_instance_dns is unset — not merely skip at runtime.
# -----------------------------------------------------------------------------
run "instance_dns_renders_no_code_when_unset" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.manage_instance_dns == false
    error_message = "manage_instance_dns must default to false (ticket 39 AC #1, ship-inert)"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "Registering per-instance DNS record")
    error_message = "manage_instance_dns=false must render ZERO per-instance DNS code into user-data.sh — not merely skip it at runtime (ticket 39 AC #1)"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "Removing DNS record")
    error_message = "The terminate-hook DNS cleanup block must also be absent from the rendered script when manage_instance_dns is unset"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "Per-instance TLS terminator SKIPPED")
    error_message = "The TLS terminator branch is runtime-gated on the SSM cert (not on manage_instance_dns) and must resolve to SKIPPED with no cert configured — proves it fails OPEN (ticket 39 AC #2)"
  }
}

run "instance_dns_renders_registration_and_cleanup_when_enabled" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    manage_instance_dns = true
    audio_domain        = "audio.flyliveapp.com"
    cloudflare_zone_id  = "mock-zone-id"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "Registering per-instance DNS record ($INSTANCE_ID.audio.flyliveapp.com)")
    error_message = "manage_instance_dns=true must render the DNS registration block, hostname derived from the SAME $INSTANCE_ID already used for INSTANCE_ID_OVERRIDE (mirrors issue 16's Vultr decision)"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "zones/mock-zone-id/dns_records")
    error_message = "The rendered Cloudflare API calls must target the configured zone id"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "Removing DNS record")
    error_message = "The terminate-hook drain script must carry the best-effort DNS cleanup block once manage_instance_dns = true"
  }
}

# -----------------------------------------------------------------------------
# aws-production 24 — AFFINITY_ENABLED reaches the instance env, inert by default.
# -----------------------------------------------------------------------------
run "affinity_env_renders_false_by_default" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.affinity_enabled == false
    error_message = "affinity_enabled must default to false (ship-inert; it is an operator attestation)"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nAFFINITY_ENABLED=false\n")
    error_message = "user-data must always render AFFINITY_ENABLED so the MSAB boot rail sees an explicit value"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nCASCADE_ENABLED=true\n")
    error_message = "cascade must stay ON by default until the ticket 24 rollout flips it"
  }
}

run "affinity_env_renders_true_when_attested" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    affinity_enabled = true
    cascade_enabled  = false
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nAFFINITY_ENABLED=true\n") && strcontains(output.user_data_rendered, "\nCASCADE_ENABLED=false\n")
    error_message = "The ticket 24 flip (affinity on, cascade off) must render both env values"
  }
}
