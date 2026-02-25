# =============================================================================
# FlyLive Audio Server — Terraform Root Configuration
# =============================================================================
# Phase 1: Single-region deployment to AWS Mumbai (ap-south-1)
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state in S3 (created via bootstrap)
  backend "s3" {
    bucket       = "flylive-audio-terraform-state"
    key          = "phase1/terraform.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = "production"
    }
  }
}

# --- Networking ---
module "networking" {
  source = "./modules/networking"

  project_name = var.project_name
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

# --- Redis ---
module "redis" {
  source = "./modules/redis"

  project_name            = var.project_name
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking.private_subnet_ids
  redis_security_group_id = module.networking.redis_security_group_id
}

# --- Compute ---
module "compute" {
  source = "./modules/compute"

  project_name         = var.project_name
  instance_type        = var.instance_type
  ssh_public_key_path  = var.ssh_public_key_path
  public_subnet_id     = module.networking.public_subnet_ids[0]
  msab_security_group_id = module.networking.msab_security_group_id
  github_repo          = var.github_repo
  github_branch        = var.github_branch
  app_port             = var.app_port
  rtc_min_port         = var.rtc_min_port
  rtc_max_port         = var.rtc_max_port
  redis_host           = module.redis.redis_host
  redis_port           = module.redis.redis_port
  redis_password       = "" # ElastiCache without auth in VPC (Phase 1)
  laravel_internal_key = var.laravel_internal_key
  jwt_secret           = var.jwt_secret
  session_secret       = var.session_secret
  audio_domain         = var.audio_domain
}

# --- SSL ---
module "ssl" {
  source = "./modules/ssl"

  project_name = var.project_name
  audio_domain = var.audio_domain
}

# --- Load Balancer ---
module "loadbalancer" {
  source = "./modules/loadbalancer"

  project_name    = var.project_name
  vpc_id          = module.networking.vpc_id
  public_subnet_ids = module.networking.public_subnet_ids
  app_port        = var.app_port
  instance_id     = module.compute.instance_id
  certificate_arn = module.ssl.certificate_arn
}

# --- SNS Event Bus ---
data "aws_caller_identity" "current" {}

module "sns" {
  source = "./modules/sns"

  project_name       = var.project_name
  aws_account_id     = data.aws_caller_identity.current.account_id
  msab_endpoint_urls = ["https://${var.audio_domain}/api/events"]
}