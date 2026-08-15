# =============================================================================
# Vultr provider
# =============================================================================
# Unlike AWS, the Vultr provider is a single GLOBAL API — region is a per-resource
# argument, NOT a provider alias. So there are no `provider "vultr" { alias = ... }`
# blocks: multi-region fleets are driven by the `fleet_regions` variable and passed
# into per-region module calls in slice D. This is an expected, correct divergence
# from the AWS stack's per-region provider fan-out.
#
# The API key is supplied out-of-band and NEVER committed — the provider reads
# it natively from the environment (so it stays out of the variable surface):
#   export VULTR_API_KEY=<personal access token from the Vultr dashboard>
# =============================================================================

provider "vultr" {
  # api_key intentionally omitted — sourced from VULTR_API_KEY in the environment.
}

# --- Cloudflare (per-instance DNS, issue 16) ---------------------------------
# Only exercised when var.manage_instance_dns = true (default false — see
# variables.tf). Configuring the provider here is itself inert: with zero
# cloudflare_dns_record resources requested, no Cloudflare API call is made,
# so an empty/placeholder token doesn't block `terraform validate` or
# `terraform test`. Same pattern as the AWS tree's provider (../terraform/main.tf)
# — token via var.cloudflare_api_token, never hardcoded.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
