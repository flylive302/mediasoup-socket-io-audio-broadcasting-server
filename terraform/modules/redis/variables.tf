# Redis Module — Variables

variable "project_name" {
  type = string
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
