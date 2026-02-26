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
    bucket       = "flylive-audio-terraform-state"
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
  alias  = "uae"
  region = "me-south-1"

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = "production"
      Region      = "uae"
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
  source = "./modules/networking"
  providers = { aws = aws.mumbai }

  project_name = var.project_name
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "redis_mumbai" {
  source = "./modules/redis"
  providers = { aws = aws.mumbai }

  project_name            = var.project_name
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking_mumbai.private_subnet_ids
  redis_security_group_id = module.networking_mumbai.redis_security_group_id
}

module "ssl_mumbai" {
  source = "./modules/ssl"
  providers = { aws = aws.mumbai }

  project_name = var.project_name
  audio_domain = var.audio_domain
}

module "loadbalancer_mumbai" {
  source = "./modules/loadbalancer"
  providers = { aws = aws.mumbai }

  project_name      = var.project_name
  vpc_id            = module.networking_mumbai.vpc_id
  public_subnet_ids = module.networking_mumbai.public_subnet_ids
  app_port          = var.app_port
  certificate_arn   = module.ssl_mumbai.certificate_arn
  # instance_id omitted — ASG manages target group registration
}

# =============================================================================
# Region: UAE / Bahrain (me-south-1)
# =============================================================================

module "networking_uae" {
  source = "./modules/networking"
  providers = { aws = aws.uae }

  project_name = var.project_name
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "redis_uae" {
  source = "./modules/redis"
  providers = { aws = aws.uae }

  project_name            = var.project_name
  redis_node_type         = "cache.t3.micro" # t4g (Graviton) not available in me-south-1
  private_subnet_ids      = module.networking_uae.private_subnet_ids
  redis_security_group_id = module.networking_uae.redis_security_group_id
}

module "ssl_uae" {
  source = "./modules/ssl"
  providers = { aws = aws.uae }

  project_name = var.project_name
  audio_domain = var.audio_domain
}

module "loadbalancer_uae" {
  source = "./modules/loadbalancer"
  providers = { aws = aws.uae }

  project_name      = var.project_name
  vpc_id            = module.networking_uae.vpc_id
  public_subnet_ids = module.networking_uae.public_subnet_ids
  app_port          = var.app_port
  certificate_arn   = module.ssl_uae.certificate_arn
  # instance_id omitted — ASG manages target group registration
}

# =============================================================================
# Region: Frankfurt (eu-central-1)
# =============================================================================

module "networking_frankfurt" {
  source = "./modules/networking"
  providers = { aws = aws.frankfurt }

  project_name = var.project_name
  app_port     = var.app_port
  rtc_min_port = var.rtc_min_port
  rtc_max_port = var.rtc_max_port
}

module "redis_frankfurt" {
  source = "./modules/redis"
  providers = { aws = aws.frankfurt }

  project_name            = var.project_name
  redis_node_type         = var.redis_node_type
  private_subnet_ids      = module.networking_frankfurt.private_subnet_ids
  redis_security_group_id = module.networking_frankfurt.redis_security_group_id
}

module "ssl_frankfurt" {
  source = "./modules/ssl"
  providers = { aws = aws.frankfurt }

  project_name = var.project_name
  audio_domain = var.audio_domain
}

module "loadbalancer_frankfurt" {
  source = "./modules/loadbalancer"
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
    "ap-south-1"  = { nlb_arn = module.loadbalancer_mumbai.nlb_arn }
    "me-south-1"  = { nlb_arn = module.loadbalancer_uae.nlb_arn }
    "eu-central-1" = { nlb_arn = module.loadbalancer_frankfurt.nlb_arn }
  }
}

# =============================================================================
# Global: SNS Event Bus (stays in Mumbai, fans out to all regions)
# =============================================================================

data "aws_caller_identity" "current" {}

module "sns" {
  source = "./modules/sns"

  project_name   = var.project_name
  aws_account_id = data.aws_caller_identity.current.account_id
  msab_endpoint_urls = [
    "https://${var.audio_domain}/api/events",
  ]
  # Note: SNS delivers to audio.flyliveapp.com which resolves to Global Accelerator.
  # GA routes to the nearest healthy NLB → EC2. Since SNS publishes from ap-south-1,
  # it will hit the Mumbai endpoint. For multi-region fan-out, we use a single
  # subscription because GA routes to the nearest region from the SNS publish location.
  #
  # If you need ALL regions to receive every event (not just nearest), uncomment:
  # msab_endpoint_urls = [
  #   "https://${module.loadbalancer_mumbai.nlb_dns_name}/api/events",
  #   "https://${module.loadbalancer_uae.nlb_dns_name}/api/events",
  #   "https://${module.loadbalancer_frankfurt.nlb_dns_name}/api/events",
  # ]
}

# =============================================================================
# Phase 3: IAM Role + Instance Profile (global — IAM is not regional)
# =============================================================================

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
}

# =============================================================================
# Phase 3: Auto Scaling Groups (one per region)
# =============================================================================
# These run ALONGSIDE existing compute modules during cutover.
# Both old (compute) and new (ASG) instances serve traffic via the same NLB.
# After ASG instances are healthy, the compute modules will be removed.
# =============================================================================

module "autoscaling_mumbai" {
  source = "./modules/autoscaling"
  providers = { aws = aws.mumbai }

  region                 = "ap-south-1"
  project_name           = var.project_name
  instance_type          = var.instance_type
  ssh_public_key_path    = var.ssh_public_key_path
  instance_profile_name  = module.iam.instance_profile_name
  msab_security_group_id = module.networking_mumbai.msab_security_group_id
  public_subnet_ids      = module.networking_mumbai.public_subnet_ids
  target_group_arn       = module.loadbalancer_mumbai.target_group_arn
  github_repo            = var.github_repo
  github_branch          = var.github_branch
  app_port               = var.app_port
  rtc_min_port           = var.rtc_min_port
  rtc_max_port           = var.rtc_max_port
  redis_host             = module.redis_mumbai.redis_host
  redis_port             = module.redis_mumbai.redis_port
  redis_password         = ""
  laravel_internal_key   = var.laravel_internal_key
  jwt_secret             = var.jwt_secret
  session_secret         = var.session_secret
  audio_domain           = var.audio_domain
}

module "autoscaling_uae" {
  source = "./modules/autoscaling"
  providers = { aws = aws.uae }

  region                 = "me-south-1"
  project_name           = var.project_name
  instance_type          = "c6i.xlarge" # c7i not available in me-south-1
  ssh_public_key_path    = var.ssh_public_key_path
  instance_profile_name  = module.iam.instance_profile_name
  msab_security_group_id = module.networking_uae.msab_security_group_id
  public_subnet_ids      = module.networking_uae.public_subnet_ids
  target_group_arn       = module.loadbalancer_uae.target_group_arn
  github_repo            = var.github_repo
  github_branch          = var.github_branch
  app_port               = var.app_port
  rtc_min_port           = var.rtc_min_port
  rtc_max_port           = var.rtc_max_port
  redis_host             = module.redis_uae.redis_host
  redis_port             = module.redis_uae.redis_port
  redis_password         = ""
  laravel_internal_key   = var.laravel_internal_key
  jwt_secret             = var.jwt_secret
  session_secret         = var.session_secret
  audio_domain           = var.audio_domain
}

module "autoscaling_frankfurt" {
  source = "./modules/autoscaling"
  providers = { aws = aws.frankfurt }

  region                 = "eu-central-1"
  project_name           = var.project_name
  instance_type          = var.instance_type
  ssh_public_key_path    = var.ssh_public_key_path
  instance_profile_name  = module.iam.instance_profile_name
  msab_security_group_id = module.networking_frankfurt.msab_security_group_id
  public_subnet_ids      = module.networking_frankfurt.public_subnet_ids
  target_group_arn       = module.loadbalancer_frankfurt.target_group_arn
  github_repo            = var.github_repo
  github_branch          = var.github_branch
  app_port               = var.app_port
  rtc_min_port           = var.rtc_min_port
  rtc_max_port           = var.rtc_max_port
  redis_host             = module.redis_frankfurt.redis_host
  redis_port             = module.redis_frankfurt.redis_port
  redis_password         = ""
  laravel_internal_key   = var.laravel_internal_key
  jwt_secret             = var.jwt_secret
  session_secret         = var.session_secret
  audio_domain           = var.audio_domain
}

# =============================================================================
# Phase 3: CloudWatch Operational Alarms
# =============================================================================

module "cloudwatch_mumbai" {
  source = "./modules/cloudwatch"
  providers = { aws = aws.mumbai }

  project_name = var.project_name
}