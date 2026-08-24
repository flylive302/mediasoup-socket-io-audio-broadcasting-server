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
#
# cloudflare_dns_record.validation is a SINGLE resource (the apex and its
# wildcard SAN share one identical ACM validation CNAME — two would 81057 at
# apply) with no for_each, so nothing here depends on the Computed
# domain_validation_options being known at plan time and no mock_resource
# default is needed. (A for_each keyed on that attribute cannot plan offline:
# mock providers don't replicate the real AWS provider's plan-time
# partial-known behavior for it. Confirmed: hashicorp/terraform#35851.)
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

# CAA precondition is exercised entirely via var.caa_records_override (see
# modules/ssl/variables.tf) — the cloudflare_dns_records data source's
# nested result schema cannot be mocked offline, so it's skipped here
# (count = 0) by leaving caa_records_override non-null below.
mock_provider "cloudflare" {}

variables {
  project_name       = "flylive-audio"
  environment        = "production"
  audio_domain       = "audio.flyliveapp.com"
  cloudflare_zone_id = "mock-zone-id"

  # Test seam (modules/ssl/variables.tf) — empty = no CAA records = the ssl
  # module's CAA precondition passes. Skips the unmockable data source.
  caa_records_override = []

  # ssh_public_key_path defaults to ~/.ssh/id_ed25519.pub, which won't exist in
  # CI — modules/autoscaling/main.tf:41 reads it via file() at plan time
  # (not mockable by the provider), so point it at a checked-in fixture.
  ssh_public_key_path = "./tests/fixtures/id_ed25519.pub"

  # Required, no-default sensitive vars (variables.tf: redis_auth_token,
  # laravel_internal_key, jwt_secret have no default).
  redis_auth_token     = "test-redis-auth-token-0123456789ab"
  laravel_internal_key = "test-internal-key-0123456789abcdef"
  jwt_secret           = "test-jwt-secret-0123456789abcdef"
  cloudflare_api_token = "test-cloudflare-api-token-0123456789ab"

  # Required, no-default (ticket 14: image_tag has no default and rejects "latest").
  image_tag = "sha-deadbeef"
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
# ASG fixed-size invariant (ticket 18 AC #2). min_size / max_size /
# desired_capacity now ALL read one variable — var.fleet_size — in
# modules/autoscaling/main.tf, so a fixed-size fleet is structural rather than a
# convention three independent numbers happen to honour. This asserts the
# rendered ASG really does come out equal on all three, whatever fleet_size is.
#
# The module-scoped drain-window / warmup / memory assertions live in their own
# file (tests/drain_window.tftest.hcl) — a `module` block in a run re-types the
# mock providers suite-wide, so mixing them here breaks the root-level runs.
# -----------------------------------------------------------------------------
run "asg_is_fixed_size_from_one_variable" {
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
    redis_cache_host       = "mock-redis-cache"
    image_tag              = "sha-deadbeef"

    # The fixed-size fleet decision under test (ticket 06 / 18 AC #2).
    fleet_size = 3
  }

  assert {
    condition     = aws_autoscaling_group.msab.min_size == aws_autoscaling_group.msab.max_size
    error_message = "ASG must render fixed-size: min_size != max_size"
  }

  assert {
    condition     = aws_autoscaling_group.msab.desired_capacity == aws_autoscaling_group.msab.min_size
    error_message = "ASG must render fixed-size: desired_capacity != min_size"
  }

  assert {
    condition     = aws_autoscaling_group.msab.min_size == var.fleet_size
    error_message = "ASG capacity must come from var.fleet_size, not from a separate number"
  }

  # ticket 18 AC #5: the two CloudWatch alarms that remain are VISIBILITY ONLY —
  # empty alarm_actions. (Absence of aws_autoscaling_policy itself can't be
  # asserted from inside terraform test — a plan has no resource inventory to
  # query — so it is gated by the `no-scaling-policy` grep step in
  # .github/workflows/terraform-aws-tests.yml.)
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.high_connections.alarm_actions) == 0 && length(aws_cloudwatch_metric_alarm.low_connections.alarm_actions) == 0
    error_message = "The connections alarms must stay visibility-only (no alarm_actions) — the fleet is fixed-size and nothing may act on them"
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
    error_message = "Target-group stickiness must stay DISABLED (ticket 23: affinity comes from epic 3a room pinning, not the LB; TIER0 F-85 showed source_ip stickiness collapsing traffic onto one instance). INFRASTRUCTURE.md claims otherwise and is wrong."
  }
}

# -----------------------------------------------------------------------------
# Ticket 23: every health-check knob is EXPLICIT in code — protocol, port,
# path, interval, timeout, and both thresholds. No AWS default left implicit.
# -----------------------------------------------------------------------------
run "loadbalancer_health_check_is_fully_explicit" {
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
    condition     = aws_lb_target_group.app.health_check[0].protocol == "HTTP" && aws_lb_target_group.app.health_check[0].path == "/health" && aws_lb_target_group.app.health_check[0].port == "3030"
    error_message = "Health check must probe HTTP /health on the app port — explicitly, not by default"
  }

  assert {
    condition     = aws_lb_target_group.app.health_check[0].interval == 30 && aws_lb_target_group.app.health_check[0].timeout == 10 && aws_lb_target_group.app.health_check[0].healthy_threshold == 2 && aws_lb_target_group.app.health_check[0].unhealthy_threshold == 3
    error_message = "Health-check interval/timeout/thresholds must all be set explicitly in code (ticket 23), not left to AWS defaults"
  }
}

# -----------------------------------------------------------------------------
# Mediasoup RTC port range (ticket 11): deliberately NARROW — 10000-10063,
# 64 ports. The app binds one shared UDP+TCP port per worker (WebRtcServer,
# worker.manager.ts: rtc_min_port + index); 64 covers a 32-vCPU instance with
# headroom. The old 50,000-port opening (max 59999) was never used and must
# not come back. Root variables are the single source consumed by both the
# networking (firewall) and autoscaling (app env) modules.
# -----------------------------------------------------------------------------
run "rtc_port_range_is_narrow" {
  command = plan

  assert {
    condition     = var.rtc_min_port == 10000
    error_message = "rtc_min_port must default to 10000 (shared by networking + autoscaling modules in every region)"
  }

  assert {
    condition     = var.rtc_max_port == 10063
    error_message = "rtc_max_port must default to 10063 — 64 per-worker WebRtcServer ports (ticket 11); the 50,000-port opening must not return"
  }

  assert {
    condition     = var.rtc_min_port < var.rtc_max_port
    error_message = "rtc_min_port must be less than rtc_max_port"
  }
}

# -----------------------------------------------------------------------------
# Regions: Mumbai-only at launch (operator decision 2026-08-10, epic
# 00-INPUTS.md §10). enabled_regions defaults to exactly ["mumbai"];
# Frankfurt/Singapore exist in code but render zero resources.
# -----------------------------------------------------------------------------
run "enabled_regions_default_is_mumbai_only" {
  command = plan

  assert {
    condition     = var.enabled_regions == toset(["mumbai"])
    error_message = "enabled_regions must default to exactly [\"mumbai\"] (Mumbai-only launch)"
  }
}

run "enabled_regions_rejects_set_without_mumbai" {
  command = plan

  variables {
    enabled_regions = ["frankfurt"]
  }

  expect_failures = [
    var.enabled_regions,
  ]
}

# -----------------------------------------------------------------------------
# Networking security group (ticket 11): only three ingress openings — the app
# port, the narrow WebRTC per-worker range (UDP+TCP), and the cascade relay
# UDP range (which is NOT dormant at single region: cascade pipes audio
# between two same-region instances via their PUBLIC IPs, so it needs an
# internet-facing rule while cascade is enabled). With cascade_ports_open =
# false the relay rule disappears entirely.
# -----------------------------------------------------------------------------
run "networking_opens_only_deliberate_ports" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    project_name       = "flylive-audio"
    vpc_cidr           = "10.20.0.0/16"
    app_port           = 3030
    rtc_min_port       = 10000
    rtc_max_port       = 10063
    cascade_ports_open = true
  }

  assert {
    condition     = alltrue([for i in aws_security_group.msab.ingress : contains([3030, 10000, 40000], i.from_port)])
    error_message = "MSAB security group must only open the app port, the narrow WebRTC range, and the cascade relay range"
  }

  assert {
    condition     = anytrue([for i in aws_security_group.msab.ingress : i.from_port == 40000 && i.to_port == 49999 && i.protocol == "udp"])
    error_message = "Cascade relay UDP 40000-49999 must be open while cascade_ports_open=true (same-region instance-to-instance audio uses public IPs)"
  }

  assert {
    condition     = !anytrue([for i in aws_security_group.msab.ingress : i.to_port > 10063 && i.protocol == "tcp"])
    error_message = "No TCP ingress may extend beyond the narrow WebRTC range (the old 50,000-port TCP opening must not return)"
  }

  assert {
    condition     = aws_subnet.public[0].cidr_block == "10.20.1.0/24"
    error_message = "Subnets must derive from var.vpc_cidr via cidrsubnet, not a hardcoded 10.10.x block"
  }
}

run "networking_cascade_rule_absent_when_closed" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    project_name       = "flylive-audio"
    vpc_cidr           = "10.20.0.0/16"
    app_port           = 3030
    rtc_min_port       = 10000
    rtc_max_port       = 10063
    cascade_ports_open = false
  }

  assert {
    condition     = !anytrue([for i in aws_security_group.msab.ingress : i.from_port == 40000])
    error_message = "cascade_ports_open=false must remove the relay ingress rule entirely"
  }
}

# -----------------------------------------------------------------------------
# ticket 39 (AWS port of MSAB issue 36) — per-instance TLS termination's
# security-group half. manage_instance_dns unset (default false) must open
# NO 443 ingress rule at all — a true no-op, not merely "not flipped yet".
# -----------------------------------------------------------------------------
run "networking_443_absent_when_manage_instance_dns_unset" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    project_name       = "flylive-audio"
    vpc_cidr           = "10.20.0.0/16"
    app_port           = 3030
    rtc_min_port       = 10000
    rtc_max_port       = 10063
    cascade_ports_open = false
  }

  assert {
    condition     = var.manage_instance_dns == false
    error_message = "manage_instance_dns must default to false (ticket 39 AC #1, ship-inert)"
  }

  assert {
    condition     = !anytrue([for i in aws_security_group.msab.ingress : i.from_port == 443])
    error_message = "No 443 ingress rule may exist while manage_instance_dns is unset — a plan with it unset must show zero 443 changes (ticket 39 AC #1)"
  }
}

# -----------------------------------------------------------------------------
# ticket 39 AC #3 — flipping the SAME var that gates the DNS record also opens
# 443, world-open like the app rule (explicit scope call — Cloudflare-only
# tightening is a noted follow-up, not silently inherited).
# -----------------------------------------------------------------------------
run "networking_443_opens_world_wide_when_flipped" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    project_name        = "flylive-audio"
    vpc_cidr            = "10.20.0.0/16"
    app_port            = 3030
    rtc_min_port        = 10000
    rtc_max_port        = 10063
    cascade_ports_open  = false
    manage_instance_dns = true
  }

  assert {
    condition     = anytrue([for i in aws_security_group.msab.ingress : i.from_port == 443 && i.to_port == 443 && i.protocol == "tcp" && contains(i.cidr_blocks, "0.0.0.0/0")])
    error_message = "manage_instance_dns=true must open a world-open 443/tcp ingress rule (same scope as app_tcp), mirroring Vultr's vultr_firewall_rule.tls_tcp (ticket 39 AC #3)"
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

# -----------------------------------------------------------------------------
# ticket 14: image_tag must be pinned — "latest" (and empty) are rejected, no
# default. variables.tf `image_tag` validation: != "" && != "latest".
# -----------------------------------------------------------------------------
run "image_tag_rejects_latest" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [
    var.image_tag,
  ]
}

# -----------------------------------------------------------------------------
# ticket 14: ECR repository must be IMMUTABLE — modules/ecr/main.tf
# `aws_ecr_repository.msab.image_tag_mutability`. A sha-tagged image can never
# be silently overwritten by a later push of the same tag.
# -----------------------------------------------------------------------------
run "ecr_repository_is_immutable" {
  command = plan

  module {
    source = "./modules/ecr"
  }

  variables {
    project_name                    = "flylive-audio"
    replication_destination_regions = []
  }

  assert {
    condition     = aws_ecr_repository.msab.image_tag_mutability == "IMMUTABLE"
    error_message = "ECR repository must be IMMUTABLE (ticket 14) — tags must never be silently overwritten"
  }
}

# -----------------------------------------------------------------------------
# aws-production/08 — the ROOT-SCOPE plan graph. tests/loadgen.tftest.hcl only
# ever plans modules/loadgen and modules/networking in ISOLATION (module {}
# runs, dummy string inputs), which never builds the actual cross-module
# reference this ticket's wiring warned about: at root, module.region_mumbai
# reads module.loadgen.security_group_id (for the msab SG's port-9100 rule)
# WHILE module.loadgen reads module.region_mumbai's vpc_id/public_subnet_ids
# (for its own placement). With loadgen_enabled = true, the id
# module.region_mumbai consumes is a genuinely UNKNOWN, computed value
# (aws_security_group.loadgen[0].id doesn't exist yet at plan time) — this is
# the ONE plan in the whole suite that actually exercises the shape the task
# flagged as a possible dependency cycle. It is a plain `run`, no `module {}`
# block, so it plans the REAL root configuration with this file's existing
# 4-alias aws mocks + cloudflare mock + full variable fixture (see file top).
#
# Passing proves two things at once: (1) no module dependency cycle — a cycle
# fails at graph-build, before any assert runs, with "Error: Cycle:"; (2) the
# unknown loadgen security-group id propagates cleanly into the msab SG's
# dynamic ingress block's `security_groups` attribute (fine — only a
# for_each/count expression may never be unknown; an ordinary attribute may).
# -----------------------------------------------------------------------------
run "loadgen_enabled_plans_cleanly_at_root_scope" {
  command = plan

  variables {
    environment     = "staging"
    loadgen_enabled = true
  }

  assert {
    condition     = strcontains(module.loadgen.user_data_rendered, "Values=staging")
    error_message = "module.loadgen's rendered user-data must carry environment=staging into the MSAB discovery filter"
  }
}
