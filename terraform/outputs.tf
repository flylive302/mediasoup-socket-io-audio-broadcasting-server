# =============================================================================
# FlyLive Audio Server — Terraform Outputs (Multi-Region)
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

# --- Mumbai ---
output "ec2_public_ip_mumbai" {
  description = "Mumbai EC2 Elastic IP"
  value       = module.compute_mumbai.elastic_ip
}

output "nlb_dns_mumbai" {
  value = module.loadbalancer_mumbai.nlb_dns_name
}

output "redis_host_mumbai" {
  value = module.redis_mumbai.redis_host
}

output "ssh_mumbai" {
  value = "ssh -i ~/.ssh/id_ed25519 ubuntu@${module.compute_mumbai.elastic_ip}"
}

# --- UAE ---
output "ec2_public_ip_uae" {
  description = "UAE EC2 Elastic IP"
  value       = module.compute_uae.elastic_ip
}

output "nlb_dns_uae" {
  value = module.loadbalancer_uae.nlb_dns_name
}

output "redis_host_uae" {
  value = module.redis_uae.redis_host
}

output "ssh_uae" {
  value = "ssh -i ~/.ssh/id_ed25519 ubuntu@${module.compute_uae.elastic_ip}"
}

# --- Frankfurt ---
output "ec2_public_ip_frankfurt" {
  description = "Frankfurt EC2 Elastic IP"
  value       = module.compute_frankfurt.elastic_ip
}

output "nlb_dns_frankfurt" {
  value = module.loadbalancer_frankfurt.nlb_dns_name
}

output "redis_host_frankfurt" {
  value = module.redis_frankfurt.redis_host
}

output "ssh_frankfurt" {
  value = "ssh -i ~/.ssh/id_ed25519 ubuntu@${module.compute_frankfurt.elastic_ip}"
}

# --- SNS ---
output "sns_topic_arn" {
  description = "SNS topic ARN — Laravel publishes events here"
  value       = module.sns.topic_arn
}
