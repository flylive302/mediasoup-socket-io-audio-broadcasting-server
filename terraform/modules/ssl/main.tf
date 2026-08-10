# =============================================================================
# SSL Module — ACM Certificate (unattended DNS validation via Cloudflare)
# =============================================================================
# The zone is hosted on Cloudflare. This module creates the ACM cert AND the
# DNS validation CNAMEs it needs, so issuance no longer waits on an operator
# to hand-copy records into the Cloudflare dashboard.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

# --- CAA pre-check ---
# ACM issuance silently fails (after the full 10m validation timeout) if the
# zone has CAA records that don't authorize Amazon's CA. Read them up front so
# a blocking CAA set fails fast at plan/early-apply instead of after the wait.
#
# The data source only runs when var.caa_records_override is null (the
# production path) — see variables.tf for why the override exists (test
# seam: this provider's nested `result` schema cannot be mocked offline).
data "cloudflare_dns_records" "caa" {
  count = var.caa_records_override == null ? 1 : 0

  zone_id = var.cloudflare_zone_id
  type    = "CAA"
}

locals {
  # Normalized CAA record list — from the live Cloudflare lookup in
  # production, or directly from var.caa_records_override in tests. ALL
  # precondition logic below is based on this local only, never on the data
  # source directly, so it works identically either way.
  caa_records = var.caa_records_override != null ? var.caa_records_override : [
    for r in data.cloudflare_dns_records.caa[0].result : { tag = r.data.tag, value = r.data.value }
  ]

  caa_issuewild     = [for r in local.caa_records : r if r.tag == "issuewild"]
  amazon_ca_domains = ["amazon.com", "amazontrust.com", "awstrust.com", "amazonaws.com"]

  # issue/issuewild CAA values look like `amazon.com` or `amazon.com; validationmethods=dns-01`
  # — only the CA domain (before any `;`) matters for authorization.
  caa_authorizes_amazon = { for r in local.caa_records :
    "${r.tag}|${r.value}" => contains(local.amazon_ca_domains, trimspace(split(";", coalesce(r.value, ""))[0]))
  }

  # Any CAA record present at all (any tag) must include at least one that
  # authorizes Amazon, OR there must be no CAA records whatsoever.
  any_caa_allows_amazon = anytrue([for k, v in local.caa_authorizes_amazon : v])

  # issuewild specifically governs the wildcard SAN (*.audio_domain) — if any
  # issuewild records exist, one of THEM (not just any CAA record) must allow
  # Amazon.
  issuewild_allows_amazon = length(local.caa_issuewild) == 0 || anytrue([
    for r in local.caa_issuewild : contains(local.amazon_ca_domains, trimspace(split(";", coalesce(r.value, ""))[0]))
  ])

  caa_precheck_ok = length(local.caa_records) == 0 || (local.any_caa_allows_amazon && local.issuewild_allows_amazon)

  caa_blocking_summary = join(", ", [
    for r in local.caa_records : "${r.tag}=${r.value}"
  ])
}

# --- Request Certificate (covers both base domain and regional subdomains) ---
resource "aws_acm_certificate" "main" {
  domain_name               = var.audio_domain
  subject_alternative_names = ["*.${var.audio_domain}"]
  validation_method         = "DNS"

  tags = {
    Name    = "${var.project_name}-cert"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = local.caa_precheck_ok
      error_message = "CAA records on the zone for ${var.audio_domain} block Amazon ACM issuance: [${local.caa_blocking_summary}]. Add a CAA record with value amazon.com, amazontrust.com, awstrust.com, or amazonaws.com (tag=issue, and tag=issuewild too if any issuewild records exist — issuewild governs the *.${var.audio_domain} SAN), or remove the blocking records."
    }
  }
}

# --- DNS validation record (Cloudflare) ---
# ONE record, not one per domain: an apex domain and its own wildcard
# (`audio.flyliveapp.com` + `*.audio.flyliveapp.com`) get the IDENTICAL
# validation CNAME from ACM (documented ACM behaviour — the wildcard shares
# the apex's record). Creating a resource per domain would try to write the
# same Cloudflare record twice and fail the second create with
# "record already exists" (error 81057) at first apply.
#
# The record's name/type/content stay unknown until apply (Computed on
# aws_acm_certificate.main.domain_validation_options) — that's fine for a
# single resource with no for_each, and keeps the resource plannable under
# `terraform test`'s mock providers (a for_each keyed on that attribute
# cannot plan offline — hashicorp/terraform#35851).
#
# proxied = false is required — a proxied CNAME resolves through Cloudflare's
# edge IPs, not the literal ACM validation target, so ACM can never see it
# and validation hangs until the 10m timeout.
resource "cloudflare_dns_record" "validation" {
  zone_id = var.cloudflare_zone_id
  name = trimsuffix(one([
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.resource_record_name
    if dvo.domain_name == var.audio_domain
  ]), ".")
  type = one([
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.resource_record_type
    if dvo.domain_name == var.audio_domain
  ])
  content = trimsuffix(one([
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.resource_record_value
    if dvo.domain_name == var.audio_domain
  ]), ".")
  ttl     = 60
  proxied = false
}

# --- Wait for DNS validation to complete ---
# This blocks downstream resources (NLB listener) until ACM issues the cert.
# validation_record_fqdns wires this to the records we just created above —
# previously nothing created them, so this resource waited on an operator's
# manual Cloudflare edit that could be forgotten or delayed.
resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [cloudflare_dns_record.validation.name]

  # Timeout after 10 minutes (DNS propagation + ACM validation)
  timeouts {
    create = "10m"
  }
}
