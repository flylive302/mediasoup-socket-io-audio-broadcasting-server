# =============================================================================
# FlyLive Audio Server — Terraform Outputs
# =============================================================================
# Region modules are count-gated by var.enabled_regions, so per-region outputs
# use one(...) and come out null for disabled regions.
# Global Accelerator outputs removed — GA dropped (ticket 11 verdict); point
# audio DNS at nlb_dns_mumbai directly.

# --- NLB DNS (per region; null when region disabled) ---
output "nlb_dns_mumbai" {
  description = "Mumbai NLB DNS — point the audio domain CNAME here (no Global Accelerator)"
  value       = one(module.region_mumbai[*].nlb_dns_name)
}

output "nlb_dns_frankfurt" {
  value = one(module.region_frankfurt[*].nlb_dns_name)
}

output "nlb_dns_singapore" {
  value = one(module.region_singapore[*].nlb_dns_name)
}

# --- Redis (per region) ---
output "redis_durable_host_mumbai" {
  value = one(module.region_mumbai[*].redis_durable_host)
}

output "redis_host_mumbai" {
  value = one(module.region_mumbai[*].redis_host)
}

output "redis_host_frankfurt" {
  value = one(module.region_frankfurt[*].redis_host)
}

output "redis_host_singapore" {
  value = one(module.region_singapore[*].redis_host)
}

# --- ASG Names (per region) ---
output "asg_name_mumbai" {
  description = "Mumbai Auto Scaling Group name"
  value       = one(module.region_mumbai[*].asg_name)
}

output "asg_name_frankfurt" {
  value = one(module.region_frankfurt[*].asg_name)
}

output "asg_name_singapore" {
  value = one(module.region_singapore[*].asg_name)
}

# --- ACM Certificate Validation Records ---
# The ssl module now creates these CNAMEs in Cloudflare automatically
# (cloudflare_dns_record.validation, proxied = false) — no operator hand-edit
# needed. Outputs kept for visibility/debugging only.
output "acm_validation_mumbai" {
  description = "ACM DNS validation records for Mumbai cert — created automatically in Cloudflare (DNS only, not proxied); shown here for visibility"
  value       = one(module.region_mumbai[*].acm_validation_records)
}

output "acm_validation_frankfurt" {
  value = one(module.region_frankfurt[*].acm_validation_records)
}

output "acm_validation_singapore" {
  value = one(module.region_singapore[*].acm_validation_records)
}

# --- Alerting ---
output "alerts_topic_arn" {
  description = "SNS topic ARN for operational alerts — single global topic (modules/alerting, ticket 32), shared by every region's alarms and module.queues"
  value       = module.alerting.alerts_topic_arn
}

# Ticket 32 PART 4 (AC-2): every CloudWatch alarm the stack declares, across
# every ENABLED region (module.region_* is count-gated by var.enabled_regions,
# so a disabled region's [*] splat is an empty list and flatten() drops it) +
# module.queues (global). scripts/verify-alarms.mjs diffs this against live
# CloudWatch — a name missing here makes that check silently under-verify.
#
# NOTE: alarm names are NOT region-qualified (they're built from project_name
# only), so if a second region is ever enabled this list will contain
# DUPLICATE strings — one per region, since CloudWatch alarms are a regional
# resource and the same name in two regions is not a collision. Fine at
# today's Mumbai-only shape; worth a second look if enabled_regions ever grows.
output "alarm_names" {
  description = "Every CloudWatch alarm name the stack declares, across all enabled regions + module.queues — consumed by scripts/verify-alarms.mjs to prove live AWS state matches what Terraform declares"
  value = concat(
    flatten(module.region_mumbai[*].alarm_names),
    flatten(module.region_frankfurt[*].alarm_names),
    flatten(module.region_singapore[*].alarm_names),
    module.queues.alarm_names,
  )
}

# --- ECR ---
output "ecr_repository_url" {
  description = "ECR repository URL — used by GitHub Actions to push images"
  value       = module.ecr.repository_url
}

# --- GitHub Actions Deploy Role (CI/CD, OIDC — ticket 12) ---
# No static keys anywhere. After apply, paste this ONE value into GitHub →
# repo Settings → Environments → aws-production → variables (not secrets —
# role ARNs are not secret) as AWS_DEPLOY_ROLE_ARN, and delete any
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY secrets still present there.
#   terraform output github_actions_role_arn
output "github_actions_role_arn" {
  description = "AWS_DEPLOY_ROLE_ARN for the aws-production GitHub environment"
  value       = module.iam.github_actions_role_arn
}
