# =============================================================================
# Valkey Module — HA Managed Database (one shared per-region endpoint)
# =============================================================================
# One shared endpoint per region is REQUIRED (not just convenient): cascade's
# origin/edge CAS room-ownership claims are coordinated through this instance,
# so every instance in the region's fleet must point at the same endpoint.
# Vultr generates and owns the admin password/CA — there is no equivalent of
# ElastiCache's `auth_token` input; the generated `password` and
# `ca_certificate` are surfaced as outputs for the compute module to consume.
# =============================================================================

terraform {
  required_providers {
    vultr = {
      source = "vultr/vultr"
    }
  }
}

resource "vultr_database" "main" {
  database_engine         = "valkey"
  database_engine_version = var.valkey_version
  region                  = var.region
  plan                    = var.valkey_plan
  label                   = "${var.project_name}-${var.environment}-${var.region}-valkey"

  # Mirrors the AWS ElastiCache parameter group's maxmemory-policy=allkeys-lru.
  eviction_policy = "allkeys-lru"
}
