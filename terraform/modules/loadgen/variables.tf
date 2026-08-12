# Loadgen Module — Variables
#
# aws-production/08: a short-lived, hand-triggered load-generator box for
# STAGING ONLY. Every resource in this module is count-gated on
# local.loadgen_enabled (var.enabled && var.environment == "staging") so a
# production plan can never render it even if var.enabled is accidentally
# flipped true — see main.tf.

variable "enabled" {
  description = <<-EOT
    Ships INERT by default. Setting this true is what stands up the loadgen
    box — but only when environment == "staging" too (see local.loadgen_enabled
    in main.tf): production can never render this module no matter how this
    flag is set. Flip back to false to tear the box down (docs/runbooks/msab-loadgen-campaign.md step 10).
  EOT
  type        = bool
  default     = false
}

variable "environment" {
  description = "Deployment environment (staging|production). This module only ever renders resources when this is \"staging\" — see local.loadgen_enabled in main.tf."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be \"staging\" or \"production\"."
  }
}

variable "project_name" {
  description = "Project name — used for resource naming (via local.env_prefix) and tags, and templated into user-data.sh as one of the EC2 tag filters the boot script uses to auto-discover the MSAB target instance (Project + Environment + Name=*-asg-instance, mirroring docs/runbooks/msab-loadgen-campaign.md step 0 / .github/workflows/deploy.yml's ASG discovery)."
  type        = string
}

variable "public_subnet_id" {
  description = "Public subnet id (from modules/networking, forwarded via modules/region) to place the loadgen instance in. Must be PUBLIC — the box needs egress for npm installs and to reach the MSAB box's public IP; private subnets in this stack have no NAT gateway."
  type        = string
}

variable "vpc_id" {
  description = "VPC id the loadgen instance's security group is created in (from modules/networking, forwarded via modules/region)."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for the load-generator box. c7i.2xlarge (8 vCPU) gives the harness's real Opus encode/decode fleet (libwebrtc, one native thread per simulated peer) real CPU headroom — the harness README states the run needs real CPU, not a token box."
  type        = string
  default     = "c7i.2xlarge"
}

variable "msab_target_host" {
  description = <<-EOT
    Explicit MSAB target hostname/IP. Empty (default) makes user-data.sh AUTO-DISCOVER
    the running MSAB instance in this project+environment at boot, via
    `aws ec2 describe-instances` tag filters (Project, Environment, Name=*-asg-instance)
    — the same discovery the operator runbook runs by hand
    (docs/runbooks/msab-loadgen-campaign.md step 0). Set explicitly only to pin a
    specific instance (e.g. debugging one box in a multi-instance fleet).
  EOT
  type        = string
  default     = ""
}

variable "msab_app_port" {
  description = "MSAB application port — both the health/metrics port scraped by Prometheus (job \"msab\", metrics_path /metrics/prometheus) and the port the harness itself connects to."
  type        = number
  default     = 3030
}

variable "internal_key_ssm_path" {
  description = <<-EOT
    SSM Parameter Store path (SecureString) of the LARAVEL_INTERNAL_KEY — the same
    secret modules/ssm writes as "/${"$"}{local.env_prefix}/laravel-internal-key" and
    modules/autoscaling/user-data.sh fetches at MSAB's own boot. Prometheus's "msab"
    scrape job sends this value as the X-Internal-Key header — MSAB's
    /metrics/prometheus route is authenticated and returns 401 without it (verified
    in docs/runbooks/msab-loadgen-campaign.md step 3, prerequisite row 2). Required —
    no default, since a wrong or missing path means every scrape 401s silently.
  EOT
  type        = string
}

variable "prometheus_version" {
  description = <<-EOT
    Prometheus release to install (github.com/prometheus/prometheus, linux-amd64
    tarball). Default 2.53.2: the scrape config's per-header `http_headers` block
    (used to send X-Internal-Key) requires Prometheus >= 2.49 — anything older
    silently rejects the config key at startup.
  EOT
  type        = string
  default     = "2.53.2"
}

variable "harness_s3_uri" {
  description = <<-EOT
    s3://bucket/key.tgz pointing at a pre-built load-harness tarball
    (scripts/load-harness, minus node_modules/runs — see docs/runbooks/msab-loadgen-campaign.md
    step 4). Empty (default) skips delivery entirely; user-data.sh logs that the
    harness must be copied onto the box by hand instead. When set, the instance
    role is ALSO granted s3:GetObject scoped to exactly this one object (main.tf
    local.harness_s3_object_arn) — never a bucket-wide grant.
  EOT
  type        = string
  default     = ""
}

variable "region" {
  description = "AWS region id this module's (default, unaliased) provider points at, e.g. ap-south-1. Rendered into user-data.sh for every regional AWS CLI call (ec2 describe-instances, ssm get-parameter, s3 cp) and used as the Prometheus scrape's expected `region` label value sanity check (docs/runbooks/msab-loadgen-campaign.md step 3, row 6)."
  type        = string
}
