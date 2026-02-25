# Redis Module — Outputs

output "redis_host" {
  value = aws_elasticache_cluster.main.cache_nodes[0].address
}

output "redis_port" {
  value = aws_elasticache_cluster.main.cache_nodes[0].port
}
