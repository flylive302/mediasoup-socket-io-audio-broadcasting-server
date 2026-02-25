# =============================================================================
# FlyLive Audio Server — Terraform Outputs
# =============================================================================

output "ec2_public_ip" {
  description = "Elastic IP of the MSAB server"
  value       = module.compute.elastic_ip
}

output "nlb_dns_name" {
  description = "NLB DNS name (point audio.flyliveapp.com here)"
  value       = module.loadbalancer.nlb_dns_name
}

output "redis_host" {
  description = "ElastiCache Redis endpoint"
  value       = module.redis.redis_host
}

output "redis_port" {
  description = "ElastiCache Redis port"
  value       = module.redis.redis_port
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.networking.vpc_id
}

output "ssh_command" {
  description = "SSH command to connect to the MSAB server"
  value       = "ssh -i ~/.ssh/id_ed25519 ubuntu@${module.compute.elastic_ip}"
}

output "sns_topic_arn" {
  description = "SNS topic ARN — Laravel publishes events here"
  value       = module.sns.topic_arn
}
