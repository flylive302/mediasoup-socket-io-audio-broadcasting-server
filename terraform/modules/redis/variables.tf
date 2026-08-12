# Redis Module — Variables

variable "project_name" {
  type = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "redis_node_type" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "redis_security_group_id" {
  type = string
}

variable "redis_auth_token" {
  description = "AUTH token for ElastiCache (must be 16-128 chars, no @, /, or quotes)"
  type        = string
  sensitive   = true
}

# --- Store-split parameters (aws-platform-build/21) ---
# The module is instantiated twice per region: a CACHE store (defaults below —
# evict-freely, no backups) and a DURABLE store (noeviction + snapshots), which
# holds the in-flight money queue and room/seat/block state.

variable "name_suffix" {
  description = "Suffix distinguishing this store's resource names (e.g. \"-durable\"). Empty keeps the original \"-redis\" names."
  type        = string
  default     = ""
}

variable "maxmemory_policy" {
  description = "Redis eviction policy. Cache store: allkeys-lru. Durable store MUST be noeviction — evicting gifts:pending loses in-flight money."
  type        = string
  default     = "allkeys-lru"
}

variable "snapshot_retention_limit" {
  description = "Days of automated snapshots to retain. 0 disables backups (cache store). Durable store must set this non-zero."
  type        = number
  default     = 0
}

variable "snapshot_window" {
  description = "Daily UTC window for automated snapshots (e.g. \"21:00-22:00\" ≈ 02:00-03:00 PKT, off-peak). Required non-null when snapshot_retention_limit > 0."
  type        = string
  default     = null
}

# --- Sizing / HA profile (aws-production/01) ---
# Defaults are the pre-ticket module literals, so production (which sets none of
# these) plans bit-identical. Staging turns them down in staging.tfvars.

variable "num_cache_clusters" {
  description = "Nodes in the replication group. 2 = primary + replica in another AZ (production). 1 = single node, no HA (staging)."
  type        = number
  default     = 2

  validation {
    condition     = var.num_cache_clusters >= 1
    error_message = "num_cache_clusters must be at least 1."
  }
}

variable "automatic_failover_enabled" {
  description = "Promote a replica automatically when the primary fails. Requires num_cache_clusters >= 2."
  type        = bool
  default     = true
}

variable "multi_az_enabled" {
  description = "Spread nodes across AZs. Requires automatic_failover_enabled."
  type        = bool
  default     = true
}
