# =============================================================================
# FlyLive Audio Server — Terraform Outputs (Phase 3: Auto-Scaling)
# =============================================================================

# --- Global Accelerator ---
output "global_accelerator_dns" {
  description = "Global Accelerator DNS (point audio.flyliveapp.com CNAME here)"
  value       = module.global_accelerator.dns_name
}

output "global_accelerator_ips" {
  description = "Global Accelerator anycast IPs"
  value       = module.global_accelerator.ip_addresses
}

# --- NLB DNS (per region) ---
output "nlb_dns_mumbai" {
  value = module.loadbalancer_mumbai.nlb_dns_name
}


output "nlb_dns_frankfurt" {
  value = module.loadbalancer_frankfurt.nlb_dns_name
}

# --- Redis (per region) ---
output "redis_host_mumbai" {
  value = module.redis_mumbai.redis_host
}


output "redis_host_frankfurt" {
  value = module.redis_frankfurt.redis_host
}

# --- ASG Names (per region) ---
output "asg_name_mumbai" {
  description = "Mumbai Auto Scaling Group name"
  value       = module.autoscaling_mumbai.asg_name
}


output "asg_name_frankfurt" {
  description = "Frankfurt Auto Scaling Group name"
  value       = module.autoscaling_frankfurt.asg_name
}

# --- SNS ---
output "sns_topic_arn" {
  description = "SNS topic ARN — Laravel publishes events here"
  value       = module.sns.topic_arn
}

# --- CloudWatch Alerts ---
output "alerts_topic_arn" {
  description = "SNS topic ARN for CloudWatch operational alerts"
  value       = module.cloudwatch_mumbai.alerts_topic_arn
}
