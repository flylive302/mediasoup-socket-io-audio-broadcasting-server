# Region composite module — outputs

output "nlb_dns_name" {
  value = module.loadbalancer.nlb_dns_name
}

output "nlb_arn" {
  value = module.loadbalancer.nlb_arn
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

output "alerts_topic_arn" {
  value = module.cloudwatch.alerts_topic_arn
}

output "vpc_id" {
  value = module.networking.vpc_id
}
