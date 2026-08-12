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

# aws-production/08: modules/loadgen (instantiated at ROOT scope, sibling to
# this module — it is test tooling, not a per-region resource) needs a public
# subnet to place the loadgen box in. Additive output, forwarded straight
# through — this module doesn't otherwise expose subnets at all.
output "public_subnet_ids" {
  description = "Public subnet ids in this region (2 AZs) — forwarded from modules/networking for root-level consumers (currently just modules/loadgen)."
  value       = module.networking.public_subnet_ids
}

output "alarm_names" {
  description = "Every alarm name this region declares (cloudwatch + autoscaling modules) — flattened into the root alarm_names output"
  value       = concat(module.cloudwatch.alarm_names, module.autoscaling.alarm_names)
}
