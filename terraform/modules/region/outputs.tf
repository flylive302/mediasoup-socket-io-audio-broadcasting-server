# Region composite module — outputs

output "nlb_dns_name" {
  value = module.loadbalancer.nlb_dns_name
}

output "nlb_arn" {
  value = module.loadbalancer.nlb_arn
}

output "redis_durable_host" {
  value = module.redis_durable.redis_host
}

# Plan-known store configs for the offline test suite (aws-platform-build/21).
output "redis_durable_config" {
  value = module.redis_durable.store_config
}

output "redis_cache_config" {
  value = module.redis.store_config
}

output "redis_host" {
  value = module.redis.redis_host
}

output "asg_name" {
  value = module.autoscaling.asg_name
}

output "acm_validation_records" {
  value = module.ssl.domain_validation_options
}

output "vpc_id" {
  value = module.networking.vpc_id
}

output "alarm_names" {
  description = "Every alarm name this region declares (cloudwatch + autoscaling modules) — flattened into the root alarm_names output"
  value       = concat(module.cloudwatch.alarm_names, module.autoscaling.alarm_names)
}
