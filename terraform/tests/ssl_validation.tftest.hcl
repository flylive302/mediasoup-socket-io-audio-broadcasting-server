# =============================================================================
# SSL module — unattended ACM validation via Cloudflare (aws-platform-build
# ticket: unattended ACM certificate issuance)
# =============================================================================
# Runs entirely offline against mocked aws + cloudflare providers — no API
# calls, no cost, no credentials. Scoped to modules/ssl directly (not the full
# root config) so these assertions stay independent of the rest of the stack.
#
# CAA scenarios are driven through var.caa_records_override (modules/ssl/
# variables.tf) rather than mocking data.cloudflare_dns_records.caa directly —
# that data source's nested `result` (list(object)) schema cannot be
# converted by terraform test's mock_data/override_data in this provider
# version (verified: identical "incompatible types; expected object type,
# found tuple" on `.result` with both a minimal 1-attribute object and an
# exhaustive object matching all documented result/result.data attributes).
# caa_records_override is a genuine test seam for exactly this reason — see
# its description in modules/ssl/variables.tf.
#
# Each assertion below was checked against the actual module code before being
# written here — see the comment above each `assert`/`run` for the source.
# =============================================================================

# cloudflare_dns_record.validation's for_each is keyed on {audio_domain,
# wildcard SAN} — known at plan time straight from config (modules/ssl/
# main.tf) — not on aws_acm_certificate.main.domain_validation_options
# directly, so no mock_resource default is needed for the for_each to plan.
# (An earlier version keyed for_each on domain_validation_options directly;
# that Computed set attribute stays unknown at plan time even under a mocked
# provider — mock providers don't replicate the real AWS provider's
# plan-time partial-known behavior for it — so a for_each keyed on it can
# never plan offline. Confirmed: hashicorp/terraform#35851.)
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }
}

# The cloudflare_dns_records data source is never evaluated in these tests —
# every run sets caa_records_override, which makes modules/ssl/main.tf's
# `data.cloudflare_dns_records.caa` count = 0. This provider still needs to
# be mockable for cloudflare_dns_record.validation (the resource, not the
# data source — its schema mocks fine).
mock_provider "cloudflare" {}

variables {
  environment        = "production"
  project_name       = "flylive-audio"
  audio_domain       = "audio.flyliveapp.com"
  cloudflare_zone_id = "mock-zone-id"
}

# -----------------------------------------------------------------------------
# modules/ssl/main.tf `cloudflare_dns_record.validation`: the single ACM
# validation CNAME (the apex and its wildcard SAN share one identical record
# — creating two would 81057 at apply). Must be
# proxied = false — a proxied CNAME resolves through Cloudflare edge IPs, not
# the literal ACM validation target, so ACM can never observe it and
# validation hangs until the 10m timeout. TTL is deliberately short (60s) so a
# reissue/rotation propagates fast.
# -----------------------------------------------------------------------------
run "validation_records_are_dns_only_with_short_ttl" {
  command = plan

  module {
    source = "./modules/ssl"
  }

  variables {
    caa_records_override = [] # no CAA records — precheck passes
  }

  assert {
    condition     = cloudflare_dns_record.validation.proxied == false
    error_message = "The ACM DNS validation CNAME must be proxied = false (DNS-only) — a proxied CNAME breaks ACM validation"
  }

  assert {
    condition     = cloudflare_dns_record.validation.ttl == 60
    error_message = "The ACM DNS validation CNAME should use a short (60s) TTL"
  }
}

# -----------------------------------------------------------------------------
# aws_acm_certificate_validation.main.validation_record_fqdns must genuinely
# depend on the records we create — otherwise validation still waits on
# nothing, same bug as before this ticket.
# -----------------------------------------------------------------------------
run "validation_waits_on_the_records_we_create" {
  command = plan

  module {
    source = "./modules/ssl"
  }

  variables {
    caa_records_override = []
  }

  # validation_record_fqdns itself is computed (unknown at plan), so the
  # "waits on our records" property is enforced structurally — the config
  # reference in modules/ssl/main.tf — and what CAN be asserted offline is
  # that the certificate covers both names (apex + wildcard SAN) while the
  # single shared validation CNAME is planned (see 81057 note atop the
  # resource for why it is one record, not two).
  assert {
    condition     = length(aws_acm_certificate.main.subject_alternative_names) == 1 && contains(aws_acm_certificate.main.subject_alternative_names, "*.${var.audio_domain}")
    error_message = "The certificate must cover the wildcard SAN alongside the apex — both are validated by the one shared CNAME"
  }
}

# -----------------------------------------------------------------------------
# CAA pre-check (modules/ssl/main.tf `aws_acm_certificate.main` lifecycle
# precondition): a CAA record set that doesn't authorize any Amazon CA
# (amazon.com / amazontrust.com / awstrust.com / amazonaws.com) must fail
# plan immediately — not after the 10m aws_acm_certificate_validation
# timeout.
# -----------------------------------------------------------------------------
run "caa_precondition_blocks_non_amazon_caa" {
  command = plan

  module {
    source = "./modules/ssl"
  }

  variables {
    caa_records_override = [
      { tag = "issue", value = "letsencrypt.org" },
    ]
  }

  expect_failures = [
    aws_acm_certificate.main,
  ]
}

# -----------------------------------------------------------------------------
# issuewild-specific rule: a general "issue" CAA record that allows Amazon is
# NOT enough on its own if an "issuewild" record exists that does not allow
# Amazon — issuewild governs the wildcard SAN (*.audio.flyliveapp.com), which
# this cert also requests. Must still fail.
# -----------------------------------------------------------------------------
run "caa_precondition_blocks_non_amazon_issuewild_even_with_amazon_issue" {
  command = plan

  module {
    source = "./modules/ssl"
  }

  variables {
    caa_records_override = [
      { tag = "issue", value = "amazon.com" },
      { tag = "issuewild", value = "letsencrypt.org" },
    ]
  }

  expect_failures = [
    aws_acm_certificate.main,
  ]
}

# -----------------------------------------------------------------------------
# A CAA set that DOES authorize Amazon (both issue and issuewild) must pass.
# -----------------------------------------------------------------------------
run "caa_precondition_allows_amazon_caa" {
  command = plan

  module {
    source = "./modules/ssl"
  }

  variables {
    caa_records_override = [
      { tag = "issue", value = "amazon.com" },
      { tag = "issuewild", value = "amazontrust.com" },
    ]
  }

  assert {
    condition     = local.caa_precheck_ok == true
    error_message = "CAA set authorizing Amazon (issue=amazon.com, issuewild=amazontrust.com) must pass the pre-check"
  }
}
