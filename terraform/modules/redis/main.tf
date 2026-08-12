# =============================================================================
# Redis Module — ElastiCache Replication Group (Multi-AZ, TLS, AUTH)
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# --- Subnet Group ---
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project_name}-redis${var.name_suffix}-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Project = var.project_name
  }
}

# --- Parameter Group ---
resource "aws_elasticache_parameter_group" "main" {
  family = "redis7"
  name   = "${var.project_name}-redis${var.name_suffix}-params"

  parameter {
    name  = "maxmemory-policy"
    value = var.maxmemory_policy
  }

  tags = {
    Project = var.project_name
  }
}

# --- ElastiCache Replication Group (Multi-AZ, TLS, AUTH) ---
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project_name}-redis${var.name_suffix}"
  description          = "${var.project_name} Redis${var.name_suffix} - Multi-AZ with TLS and AUTH"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_clusters   = var.num_cache_clusters # 2 = primary + 1 replica in a different AZ
  parameter_group_name = aws_elasticache_parameter_group.main.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [var.redis_security_group_id]
  port                 = 6379

  # High Availability (aws-production/01: per-environment — production keeps the
  # 2-node multi-AZ topology, staging runs a single node to stop a ~$650/mo burn).
  automatic_failover_enabled = var.automatic_failover_enabled
  multi_az_enabled           = var.multi_az_enabled

  # Encryption
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = var.redis_auth_token

  # Durability (aws-platform-build/21): 0/null on the cache store; the durable
  # store sets both explicitly — its snapshots are the only backup of the
  # in-flight money queue.
  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = var.snapshot_window

  # Maintenance
  apply_immediately = true

  lifecycle {
    precondition {
      condition     = var.snapshot_retention_limit == 0 || var.snapshot_window != null
      error_message = "snapshot_window must be set explicitly when snapshots are enabled (snapshot_retention_limit > 0)."
    }

    # aws-production/01: fail at PLAN, not at apply. ElastiCache refuses
    # automatic failover (and multi-AZ, which requires failover) on a
    # single-node group — a combination only reachable from tfvars.
    precondition {
      condition     = !var.automatic_failover_enabled || var.num_cache_clusters >= 2
      error_message = "automatic_failover_enabled requires num_cache_clusters >= 2 (a single-node replication group has nothing to fail over to)."
    }

    precondition {
      condition     = !var.multi_az_enabled || var.automatic_failover_enabled
      error_message = "multi_az_enabled requires automatic_failover_enabled (AWS rejects multi-AZ without failover)."
    }
  }

  tags = {
    Name    = "${var.project_name}-redis${var.name_suffix}"
    Project = var.project_name
  }
}
