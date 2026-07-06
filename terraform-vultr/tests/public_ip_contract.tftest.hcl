# =============================================================================
# Public-IP contract test (04-single-region-vultr-tracer.md, required AC)
# =============================================================================
# Validates the CONTRACT — "the announced IP is a real, public, reachable
# address" — not the shell mechanics of cloud-init. Runs entirely offline
# against a mocked Vultr provider (no API calls, no cost, no credentials
# needed), by overriding `vultr_reserved_ip.main.subnet` to controlled values
# and asserting `module.compute`'s output precondition (see
# modules/compute/outputs.tf) accepts a public IPv4 and rejects
# private/loopback/link-local/empty ones.
# =============================================================================

mock_provider "vultr" {
  override_during = plan
}

# The real vultr_os data source's `id` is a numeric os_id (e.g. 2284) despite
# being schema-typed as a string; Terraform auto-converts it when assigned to
# vultr_instance.os_id (a number). The mock generator doesn't know that
# convention and produces a non-numeric placeholder string, so pin it here.
override_data {
  target = module.compute.data.vultr_os.ubuntu
  values = {
    id = "2284"
  }
}

variables {
  project_name = "flylive-audio"
  environment  = "staging"
  audio_domain = "audio.staging.flyliveapp.com"
  cors_origins = "https://staging.flyliveapp.com"

  laravel_api_url      = "https://app.staging.flyliveapp.com"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret           = "test-jwt-secret-0123456789abcdef"
  session_secret       = "test-session-secret-0123456789ab"

  tracer_region   = "bom"
  instance_plan   = "vhf-2c-4gb"
  image_tag       = "sha-testtest"
  ghcr_pull_token = "test-pull-token"

  cloudflare_turn_api_key = "test-turn-key"
  cloudflare_turn_key_id  = "test-turn-key-id"

  lb_ssl_certificate = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----"
  lb_ssl_private_key = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----"
}

run "public_ip_passes_contract" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main
    override_during = plan
    values = {
      subnet = "203.0.113.45"
    }
  }

  assert {
    condition     = output.tracer_public_ip == "203.0.113.45"
    error_message = "expected the public_ip output to pass through the overridden reserved IP"
  }
}

run "private_ip_rejected" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main
    override_during = plan
    values = {
      subnet = "10.0.5.5"
    }
  }

  expect_failures = [
    output.tracer_public_ip,
  ]
}

run "loopback_ip_rejected" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main
    override_during = plan
    values = {
      subnet = "127.0.0.1"
    }
  }

  expect_failures = [
    output.tracer_public_ip,
  ]
}

run "empty_ip_rejected" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main
    override_during = plan
    values = {
      subnet = ""
    }
  }

  expect_failures = [
    output.tracer_public_ip,
  ]
}
