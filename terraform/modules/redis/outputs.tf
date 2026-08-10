# Redis Module — Outputs

output "redis_host" {
  description = "Primary endpoint for the Redis replication group"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_port" {
  value = 6379
}

# Rendered store configuration — plan-known (var-derived), exposed so the
# offline test suite can assert the durable/cache split (aws-platform-build/21)
# from root-level runs; nested module resources aren't reachable there.
output "store_config" {
  value = {
    replication_group_id     = "${var.project_name}-redis${var.name_suffix}"
    maxmemory_policy         = var.maxmemory_policy
    snapshot_retention_limit = var.snapshot_retention_limit
    snapshot_window          = var.snapshot_window
  }
}
