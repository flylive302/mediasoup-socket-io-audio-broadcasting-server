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
