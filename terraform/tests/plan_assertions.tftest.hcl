# =============================================================================
# AWS stack — rendered-plan assertions (ticket 10, seam 1)
# =============================================================================
# Runs entirely offline against a mocked AWS provider (no API calls, no cost, no
# credentials) — required because CI has no valid AWS creds yet (aws-production
# GitHub keys are from a closed account, pending reissue). mock_provider
# auto-generates values for every resource/data source attribute Terraform
# doesn't otherwise know, so `terraform plan` can complete without touching AWS.
#
# Each assertion below was checked against the actual module code before being
# written here — see the comment above each `assert` for the source line(s).
# =============================================================================

# The root module wires three region-aliased providers (main.tf: mumbai,
# frankfurt, singapore) plus the default — every one must be mocked or the
# plan reaches out to real AWS for credentials.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "aws" {
  alias = "mumbai"

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "aws" {
  alias = "frankfurt"

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

mock_provider "aws" {
  alias = "singapore"

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

variables {
  project_name = "flylive-audio"
  environment  = "production"
  audio_domain = "audio.flyliveapp.com"

  # ssh_public_key_path defaults to ~/.ssh/id_ed25519.pub, which won't exist in
  # CI — modules/autoscaling/main.tf:41 reads it via file() at plan time
  # (not mockable by the provider), so point it at a checked-in fixture.
  ssh_public_key_path = "./tests/fixtures/id_ed25519.pub"

  # Required, no-default sensitive vars (variables.tf: redis_auth_token,
  # laravel_internal_key, jwt_secret have no default).
  redis_auth_token     = "test-redis-auth-token-0123456789ab"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret            = "test-jwt-secret-0123456789abcdef"
}

# -----------------------------------------------------------------------------
# instance_type default is c7i.xlarge (operator decision 2026-08-10, epic
# 00-INPUTS.md §10). Source: terraform/variables.tf `instance_type` default,
# threaded into every region's autoscaling module and its launch template
# (modules/autoscaling/main.tf `aws_launch_template.msab.instance_type`).
# -----------------------------------------------------------------------------
run "instance_type_default_is_c7i_xlarge" {
  command = plan

  assert {
    condition     = var.instance_type == "c7i.xlarge"
    error_message = "instance_type default must be c7i.xlarge per operator decision (epic 00-INPUTS.md §10)"
  }
}

# -----------------------------------------------------------------------------
# ASG fixed-size invariant: modules/autoscaling/main.tf `aws_autoscaling_group.msab`
# sets min_size = var.min_instances, max_size = var.max_instances,
# desired_capacity = var.desired_instances — three independent variables, no
# module-level enforcement that they're equal. This asserts that when the root
# module is given equal values (the fixed-size fleet decision), the rendered
# ASG for every region actually comes out fixed-size — it does NOT assert the
# variables' defaults are fixed-size, because they aren't (default max=50).
# -----------------------------------------------------------------------------
run "asg_is_fixed_size_when_variables_set_equal" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    # Required (no-default) module inputs — dummies, never applied.
    region                 = "ap-south-1"
    project_name           = "flylive-audio"
    ssh_public_key_path    = "./tests/fixtures/id_ed25519.pub"
    instance_profile_name  = "mock-profile"
    msab_security_group_id = "sg-mock"
    public_subnet_ids      = ["subnet-mock-a", "subnet-mock-b"]
    target_group_arn       = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:targetgroup/mock/abc"
    ecr_repo_url           = "111111111111.dkr.ecr.ap-south-1.amazonaws.com/flylive-audio/msab"
    redis_host             = "mock-redis"
    laravel_internal_key   = "test-internal-key-0123456789abcdef"
    jwt_secret             = "test-jwt-secret-0123456789abcdef"
    audio_domain           = "audio.flyliveapp.com"

    # The fixed-size fleet decision under test (ticket 06, min = max = desired).
    min_instances     = 3
    max_instances     = 3
    desired_instances = 3
  }

  assert {
    condition     = aws_autoscaling_group.msab.min_size == aws_autoscaling_group.msab.max_size
    error_message = "ASG must render fixed-size: min_size != max_size"
  }

  assert {
    condition     = aws_autoscaling_group.msab.desired_capacity == aws_autoscaling_group.msab.min_size
    error_message = "ASG must render fixed-size: desired_capacity != min_size"
  }
}

# -----------------------------------------------------------------------------
# Load balancer stickiness is DISABLED — modules/loadbalancer/main.tf
# `aws_lb_target_group.app.stickiness { enabled = false, type = "source_ip" }`,
# with an inline TIER0 (F-85) rationale (Global Accelerator + source_ip
# stickiness collapses new connections onto one instance). INFRASTRUCTURE.md
# wrongly claims stickiness is enabled and "critical for WebSocket
# connections" — this test asserts the code's actual (opposite) behaviour.
# -----------------------------------------------------------------------------
run "loadbalancer_stickiness_is_disabled" {
  command = plan

  module {
    source = "./modules/loadbalancer"
  }

  variables {
    project_name      = "flylive-audio"
    vpc_id            = "vpc-mock"
    public_subnet_ids = ["subnet-mock-a", "subnet-mock-b"]
    app_port          = 3030
  }

  assert {
    condition     = aws_lb_target_group.app.stickiness[0].enabled == false
    error_message = "Target-group stickiness must stay DISABLED (TIER0 F-85: GA + source_ip stickiness collapses traffic onto one instance). INFRASTRUCTURE.md claims otherwise and is wrong."
  }
}

# -----------------------------------------------------------------------------
# Mediasoup RTC port range is consistent between root variables and every
# region's networking + autoscaling module (terraform/variables.tf
# rtc_min_port=10000 / rtc_max_port=59999, passed unchanged into
# module.networking_* — main.tf:103-104,149-150,199-200 — and
# module.autoscaling_* — main.tf:385-386,443-444,500-501). Asserted via the
# root variables (the single source both module families consume) rather than
# re-deriving from rendered security-group/launch-template internals.
# -----------------------------------------------------------------------------
run "rtc_port_range_consistent_across_modules" {
  command = plan

  assert {
    condition     = var.rtc_min_port == 10000
    error_message = "rtc_min_port must default to 10000 (shared by networking + autoscaling modules in every region)"
  }

  assert {
    condition     = var.rtc_max_port == 59999
    error_message = "rtc_max_port must default to 59999 (shared by networking + autoscaling modules in every region)"
  }

  assert {
    condition     = var.rtc_min_port < var.rtc_max_port
    error_message = "rtc_min_port must be less than rtc_max_port"
  }
}

# -----------------------------------------------------------------------------
# environment variable only allows staging|production — variables.tf
# `environment` validation block: contains(["staging", "production"], var.environment).
# A test run with an invalid value must fail plan with that validation error.
# -----------------------------------------------------------------------------
run "environment_accepts_production" {
  command = plan

  variables {
    environment = "production"
  }

  assert {
    condition     = var.environment == "production"
    error_message = "environment=production must be accepted"
  }
}

run "environment_accepts_staging" {
  command = plan

  variables {
    environment = "staging"
  }

  assert {
    condition     = var.environment == "staging"
    error_message = "environment=staging must be accepted"
  }
}

run "environment_rejects_invalid_value" {
  command = plan

  variables {
    environment = "development"
  }

  expect_failures = [
    var.environment,
  ]
}
