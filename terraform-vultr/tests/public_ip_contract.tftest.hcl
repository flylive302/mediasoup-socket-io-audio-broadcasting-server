# =============================================================================
# Public-IP contract test (slice 05 — fleet-wide, extends slice D's single-IP)
# =============================================================================
# Validates the CONTRACT — "EVERY fleet instance announces a real, public,
# reachable address" — not the shell mechanics of cloud-init. Runs entirely
# offline against a mocked Vultr provider (no API calls, no cost, no credentials),
# by overriding each `vultr_reserved_ip.main[i].subnet` to controlled values and
# asserting the root `tracer_public_ips` output precondition (backed by
# modules/compute's `all_public_ipv4` = alltrue over the fleet) accepts an
# all-public fleet and rejects a fleet where ANY instance's IP is
# private/loopback/link-local/empty.
#
# instance_count is driven by fleet_regions[tracer_region] (= bom => 2 here), so
# these runs exercise the genuine multi-instance case: one bad index must fail
# the whole fleet's contract.
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

  # 2-instance fleet in the tracer region — the slice-05 multi-instance case.
  fleet_regions   = { bom = 2, fra = 2, sgp = 2 }
  tracer_region   = "bom"
  instance_plan   = "vhf-2c-4gb"
  image_tag       = "sha-testtest"
  ghcr_pull_token = "test-pull-token"

  cloudflare_turn_api_key = "test-turn-key"
  cloudflare_turn_key_id  = "test-turn-key-id"

  lb_ssl_certificate = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----"
  lb_ssl_private_key = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----"
}

run "all_instances_public_ip_passes_contract" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main[0]
    override_during = plan
    values          = { subnet = "203.0.113.45" }
  }
  override_resource {
    target          = module.compute.vultr_reserved_ip.main[1]
    override_during = plan
    values          = { subnet = "198.51.100.20" }
  }

  assert {
    condition = (
      length(output.tracer_public_ips) == 2
      && output.tracer_public_ips[0] == "203.0.113.45"
      && output.tracer_public_ips[1] == "198.51.100.20"
    )
    error_message = "expected tracer_public_ips to pass through both overridden reserved IPs, in index order"
  }
}

# One private IP on index 0 must fail the WHOLE fleet's contract (alltrue), even
# though index 1 is public — the load-bearing multi-instance assertion.
run "one_private_ip_rejects_fleet" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main[0]
    override_during = plan
    values          = { subnet = "10.0.5.5" }
  }
  override_resource {
    target          = module.compute.vultr_reserved_ip.main[1]
    override_during = plan
    values          = { subnet = "198.51.100.20" }
  }

  expect_failures = [
    output.tracer_public_ips,
  ]
}

# Loopback on index 1 (the non-first slot) must also fail — proves the check is
# index-independent, not just guarding instance 0.
run "one_loopback_ip_rejects_fleet" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main[0]
    override_during = plan
    values          = { subnet = "203.0.113.45" }
  }
  override_resource {
    target          = module.compute.vultr_reserved_ip.main[1]
    override_during = plan
    values          = { subnet = "127.0.0.1" }
  }

  expect_failures = [
    output.tracer_public_ips,
  ]
}

# An empty IP (reserved-IP never materialised) on any index must fail.
run "one_empty_ip_rejects_fleet" {
  command = plan

  override_resource {
    target          = module.compute.vultr_reserved_ip.main[0]
    override_during = plan
    values          = { subnet = "" }
  }
  override_resource {
    target          = module.compute.vultr_reserved_ip.main[1]
    override_during = plan
    values          = { subnet = "198.51.100.20" }
  }

  expect_failures = [
    output.tracer_public_ips,
  ]
}
