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

output "nlb_dns_singapore" {
  value = module.loadbalancer_singapore.nlb_dns_name
}

# --- Redis (per region) ---
output "redis_host_mumbai" {
  value = module.redis_mumbai.redis_host
}


output "redis_host_frankfurt" {
  value = module.redis_frankfurt.redis_host
}

output "redis_host_singapore" {
  value = module.redis_singapore.redis_host
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

output "asg_name_singapore" {
  description = "Singapore Auto Scaling Group name"
  value       = module.autoscaling_singapore.asg_name
}

# --- SNS ---
output "sns_topic_arn" {
  description = "SNS topic ARN — Laravel publishes events here"
  value       = module.sns.topic_arn
}

# --- ACM Certificate Validation Records ---
# Run `terraform output acm_validation_mumbai` and `acm_validation_frankfurt` DURING apply
# to get the exact CNAME records to add in Cloudflare (required for cert to issue).
output "acm_validation_mumbai" {
  description = "ACM DNS validation records for Mumbai cert — add these CNAMEs in Cloudflare (DNS only, not proxied)"
  value       = module.ssl_mumbai.domain_validation_options
}

output "acm_validation_frankfurt" {
  description = "ACM DNS validation records for Frankfurt cert — add these CNAMEs in Cloudflare (DNS only, not proxied)"
  value       = module.ssl_frankfurt.domain_validation_options
}

# Singapore's cert covers the same apex + *.audio.flyliveapp.com in the same account,
# so the validation CNAMEs likely already exist — diff and add any missing ones.
output "acm_validation_singapore" {
  description = "ACM DNS validation records for Singapore cert — add these CNAMEs in Cloudflare (DNS only, not proxied)"
  value       = module.ssl_singapore.domain_validation_options
}

# --- CloudWatch Alerts ---
output "alerts_topic_arn" {
  description = "SNS topic ARN for CloudWatch operational alerts"
  value       = module.cloudwatch_mumbai.alerts_topic_arn
}

# --- ECR ---
output "ecr_repository_url" {
  description = "ECR repository URL — used by GitHub Actions to push images"
  value       = module.ecr.repository_url
}

# --- GitHub Actions Deploy User (CI/CD) ---
# After apply, paste these into GitHub → repo Settings → Environments →
# aws-production → secrets (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
#   terraform output github_actions_access_key_id
#   terraform output -raw github_actions_secret_access_key
output "github_actions_access_key_id" {
  description = "AWS_ACCESS_KEY_ID for the aws-production GitHub environment"
  value       = module.iam.github_actions_access_key_id
}

output "github_actions_secret_access_key" {
  description = "AWS_SECRET_ACCESS_KEY for the aws-production GitHub environment"
  value       = module.iam.github_actions_secret_access_key
  sensitive   = true
}
