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
  name       = "${var.project_name}-redis-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Project = var.project_name
  }
}

# --- Parameter Group ---
resource "aws_elasticache_parameter_group" "main" {
  family = "redis7"
  name   = "${var.project_name}-redis-params"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = {
    Project = var.project_name
  }
}

# --- ElastiCache Replication Group (Multi-AZ, TLS, AUTH) ---
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project_name} - Redis"
  description          = "${var.project_name} Redis - Multi-AZ with TLS and AUTH"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_clusters   = 2 # Primary + 1 replica in different AZ
  parameter_group_name = aws_elasticache_parameter_group.main.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [var.redis_security_group_id]
  port                 = 6379

  # High Availability
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # Encryption
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = var.redis_auth_token

  # Maintenance
  apply_immediately = true

  tags = {
    Name    = "${var.project_name}-redis"
    Project = var.project_name
  }
}
