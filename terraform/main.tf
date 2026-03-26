# =============================================================================
# FlyLive Audio Server — Terraform Root Configuration
# =============================================================================
# Phase 2: Multi-region deployment (Mumbai, UAE, Frankfurt)
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
    bucket       = "flylive-audio-tfstate-778477255323"
    key          = "phase1/terraform.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
    encrypt      = true
  }
}

# =============================================================================
# Provider Aliases — one per region
# =============================================================================

provider "aws" {
  alias  = "mumbai"
  region = "ap-south-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = "production"
      Region      = "mumbai"
    }
  }
}


provider "aws" {
  alias  = "frankfurt"
  region = "eu-central-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = "production"
      Region      = "frankfurt"
    }
  }
}

# Default provider (Mumbai) — used by global resources like SNS
provider "aws" {
  region = "ap-south-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = "production"
    }
  }
}

# =============================================================================
# Region: Mumbai (ap-south-1) — existing infrastructure
# =============================================================================

module "networking_mumbai" {
  source    = "./modules/networking"
  providers = { aws = aws.mumbai }

  project_name = var.project_name
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "redis_mumbai" {
  source    = "./modules/redis"
  providers = { aws = aws.mumbai }

  project_name            = var.project_name
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking_mumbai.private_subnet_ids
  redis_security_group_id = module.networking_mumbai.redis_security_group_id
  redis_auth_token        = var.redis_auth_token
}

module "ssl_mumbai" {
  source    = "./modules/ssl"
  providers = { aws = aws.mumbai }

  project_name = var.project_name
  audio_domain = var.audio_domain
}

module "loadbalancer_mumbai" {
  source    = "./modules/loadbalancer"
  providers = { aws = aws.mumbai }

  project_name      = var.project_name
  vpc_id            = module.networking_mumbai.vpc_id
  public_subnet_ids = module.networking_mumbai.public_subnet_ids
  app_port          = var.app_port
  certificate_arn   = module.ssl_mumbai.certificate_arn
  # instance_id omitted — ASG manages target group registration
}


# =============================================================================
# Region: Frankfurt (eu-central-1)
# =============================================================================

module "networking_frankfurt" {
  source    = "./modules/networking"
  providers = { aws = aws.frankfurt }

  project_name = var.project_name
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "redis_frankfurt" {
  source    = "./modules/redis"
  providers = { aws = aws.frankfurt }

  project_name            = var.project_name
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking_frankfurt.private_subnet_ids
  redis_security_group_id = module.networking_frankfurt.redis_security_group_id
  redis_auth_token        = var.redis_auth_token
}

module "ssl_frankfurt" {
  source    = "./modules/ssl"
  providers = { aws = aws.frankfurt }

  project_name = var.project_name
  audio_domain = var.audio_domain
}

module "loadbalancer_frankfurt" {
  source    = "./modules/loadbalancer"
  providers = { aws = aws.frankfurt }

  project_name      = var.project_name
  vpc_id            = module.networking_frankfurt.vpc_id
  public_subnet_ids = module.networking_frankfurt.public_subnet_ids
  app_port          = var.app_port
  certificate_arn   = module.ssl_frankfurt.certificate_arn
  # instance_id omitted — ASG manages target group registration
}

# =============================================================================
# Global: AWS Global Accelerator
# =============================================================================

module "global_accelerator" {
  source = "./modules/global-accelerator"

  project_name = var.project_name

  regional_endpoints = {
    "ap-south-1"   = { nlb_arn = module.loadbalancer_mumbai.nlb_arn }
    "eu-central-1" = { nlb_arn = module.loadbalancer_frankfurt.nlb_arn }
  }
}

# =============================================================================
# Global: ECR Container Registry (one repo, all regions pull from it)
# =============================================================================

module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name
}

# =============================================================================
# Global: SNS Event Bus (stays in Mumbai, fans out to all regions)
# =============================================================================

data "aws_caller_identity" "current" {}

module "sns" {
  source = "./modules/sns"

  project_name         = var.project_name
  aws_account_id       = data.aws_caller_identity.current.account_id
  laravel_internal_key = var.laravel_internal_key

  # Fan-out to BOTH regional NLB endpoints directly (not via GA)
  # GA would route to nearest region only — we need ALL regions to receive every event
  msab_endpoint_urls = [
    "https://${module.loadbalancer_mumbai.nlb_dns_name}/api/events",
    "https://${module.loadbalancer_frankfurt.nlb_dns_name}/api/events",
  ]
}

# =============================================================================
# Phase 3: IAM Role + Instance Profile (global — IAM is not regional)
# =============================================================================

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
}

# =============================================================================
# Secrets: SSM Parameter Store (encrypted at rest, fetched at boot via IAM)
# =============================================================================

module "ssm" {
  source = "./modules/ssm"

  project_name            = var.project_name
  jwt_secret              = var.jwt_secret
  laravel_internal_key    = var.laravel_internal_key
  session_secret          = var.session_secret
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  redis_auth_token        = var.redis_auth_token
}

# =============================================================================
# Phase 3: Auto Scaling Groups (one per region)
# =============================================================================
# These run ALONGSIDE existing compute modules during cutover.
# Both old (compute) and new (ASG) instances serve traffic via the same NLB.
# After ASG instances are healthy, the compute modules will be removed.
# =============================================================================

module "autoscaling_mumbai" {
  source    = "./modules/autoscaling"
  providers = { aws = aws.mumbai }

  region                 = "ap-south-1"
  project_name           = var.project_name
  instance_type          = var.instance_type
  ssh_public_key_path    = var.ssh_public_key_path
  instance_profile_name  = module.iam.instance_profile_name
  msab_security_group_id = module.networking_mumbai.msab_security_group_id
  public_subnet_ids      = module.networking_mumbai.public_subnet_ids
  target_group_arn       = module.loadbalancer_mumbai.target_group_arn
  ecr_repo_url           = module.ecr.repository_url
  app_port               = var.app_port
  rtc_min_port           = var.rtc_min_port
  rtc_max_port           = var.rtc_max_port
  redis_host             = module.redis_mumbai.redis_host
  redis_port             = module.redis_mumbai.redis_port
  redis_password         = var.redis_auth_token
  laravel_internal_key   = var.laravel_internal_key
  jwt_secret             = var.jwt_secret
  session_secret         = var.session_secret
  audio_domain           = var.audio_domain
  cascade_enabled        = true
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  cloudflare_turn_key_id  = var.cloudflare_turn_key_id

  # AUDIT-004 FIX: HA — always run 2 instances to eliminate single point of failure
  min_instances     = 2
  desired_instances = 2

  # Zero Healthy Hosts alarm dimensions
  target_group_arn_suffix       = module.loadbalancer_mumbai.target_group_arn_suffix
  load_balancer_arn_suffix      = module.loadbalancer_mumbai.nlb_arn_suffix
  alarm_notification_topic_arn  = module.cloudwatch_mumbai.alerts_topic_arn
}


module "autoscaling_frankfurt" {
  source    = "./modules/autoscaling"
  providers = { aws = aws.frankfurt }

  region                 = "eu-central-1"
  project_name           = var.project_name
  instance_type          = var.instance_type
  ssh_public_key_path    = var.ssh_public_key_path
  instance_profile_name  = module.iam.instance_profile_name
  msab_security_group_id = module.networking_frankfurt.msab_security_group_id
  public_subnet_ids      = module.networking_frankfurt.public_subnet_ids
  target_group_arn       = module.loadbalancer_frankfurt.target_group_arn
  ecr_repo_url           = module.ecr.repository_url
  app_port               = var.app_port
  rtc_min_port           = var.rtc_min_port
  rtc_max_port           = var.rtc_max_port
  redis_host             = module.redis_frankfurt.redis_host
  redis_port             = module.redis_frankfurt.redis_port
  redis_password         = var.redis_auth_token
  laravel_internal_key   = var.laravel_internal_key
  jwt_secret             = var.jwt_secret
  session_secret         = var.session_secret
  audio_domain           = var.audio_domain
  cascade_enabled        = true
  cloudflare_turn_api_key = var.cloudflare_turn_api_key
  cloudflare_turn_key_id  = var.cloudflare_turn_key_id

  # AUDIT-004 FIX: HA — always run 2 instances to eliminate single point of failure
  min_instances     = 2
  desired_instances = 2

  # Zero Healthy Hosts alarm dimensions
  target_group_arn_suffix       = module.loadbalancer_frankfurt.target_group_arn_suffix
  load_balancer_arn_suffix      = module.loadbalancer_frankfurt.nlb_arn_suffix
  alarm_notification_topic_arn  = module.cloudwatch_frankfurt.alerts_topic_arn
}

# =============================================================================
# Phase 3: CloudWatch Operational Alarms
# =============================================================================

module "cloudwatch_mumbai" {
  source    = "./modules/cloudwatch"
  providers = { aws = aws.mumbai }

  project_name = var.project_name
  aws_region   = "ap-south-1"
}

module "cloudwatch_frankfurt" {
  source    = "./modules/cloudwatch"
  providers = { aws = aws.frankfurt }

  project_name = var.project_name
  aws_region   = "eu-central-1"
}