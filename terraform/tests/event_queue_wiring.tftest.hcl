# =============================================================================
# aws-production/28 Phase A step 5 — the SQS consumer's queue URL reaches the
# instance env, or it doesn't run at all
# =============================================================================
# The defect these runs exist to prevent already happened once, silently:
# `EVENT_QUEUE_URL` was documented as set "from the first serving minute"
# (runbook §3a) and was in fact wired NOWHERE — not in user-data, not in either
# env file, not in any module input. The IAM consume policy existed, the queue
# existed, the consumer code existed, and `createQueueConsumer()` still returned
# null on every boot because the one string it needs never reached the box.
# Terraform planned clean throughout: nothing in a plan can notice a variable
# that was never plumbed.
#
# So these assertions are made against the RENDERED user-data, the text that
# actually runs on the instance — the same reason drain_window.tftest.hcl
# asserts there rather than on locals.
#
# MODULE-SCOPED (`module { source = "./modules/autoscaling" }`), which re-types
# the suite's mock providers, so this lives in its own file — see
# drain_window.tftest.hcl's header for why that separation is not optional.
#
# ⚠️ After adding this file, re-run `terraform init -backend=false` before
# `terraform test`, or Terraform reports "Module not installed" and then a
# misleading provider-type-mismatch cascade.
# =============================================================================

mock_provider "aws" {}

variables {
  # Required (no-default) module inputs — dummies, never applied.
  region                 = "ap-south-1"
  project_name           = "flylive-audio"
  environment            = "production"
  ssh_public_key_path    = "./tests/fixtures/id_ed25519.pub"
  instance_profile_name  = "mock-profile"
  msab_security_group_id = "sg-mock"
  public_subnet_ids      = ["subnet-mock-a", "subnet-mock-b"]
  target_group_arn       = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:targetgroup/mock/abc"
  ecr_repo_url           = "111111111111.dkr.ecr.ap-south-1.amazonaws.com/flylive-audio/msab"
  redis_host             = "mock-redis"
  redis_cache_host       = "mock-redis-cache"
  image_tag              = "sha-deadbeef"
}

# -----------------------------------------------------------------------------
# ARMED: a queue URL passed in must appear in the env file as its OWN line.
# The `\n…\n` anchors are load-bearing — the comment block above the value names
# EVENT_QUEUE_URL in prose, so a substring match would pass on the comment alone
# while the variable itself went unrendered.
# -----------------------------------------------------------------------------
run "queue_url_reaches_the_instance_env" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    event_queue_url = "https://sqs.ap-south-1.amazonaws.com/505307260926/flylive-audio-production-msab-events.fifo"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nEVENT_QUEUE_URL=${var.event_queue_url}\n")
    error_message = "EVENT_QUEUE_URL must be rendered into the instance env verbatim — without it createQueueConsumer() returns null and the SQS consumer silently never starts"
  }
}

# -----------------------------------------------------------------------------
# INERT: the default renders NO line at all. This is the ships-inert half of the
# contract — an empty `EVENT_QUEUE_URL=` line would also be inert today (MSAB's
# schema defaults it to ""), but asserting on absence keeps the env file honest:
# a key that is present reads as configured to every operator who greps for it,
# and this fleet has now been bitten twice by config that looked set and wasn't.
# -----------------------------------------------------------------------------
run "no_queue_url_renders_no_key_at_all" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.event_queue_url == ""
    error_message = "event_queue_url must default to empty — the consumer ships inert and is armed by the root module passing module.queues.queue_url"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "\nEVENT_QUEUE_URL=")
    error_message = "With no queue URL configured the env file must carry no EVENT_QUEUE_URL key at all — an empty key reads as 'configured' to anyone grepping the instance"
  }
}

# -----------------------------------------------------------------------------
# ticket 28 step 13 — EVENT_HTTP_INGEST_ENABLED, the HTTP ingest retirement
# switch. Same ships-inert contract as EVENT_QUEUE_URL above: the default
# (true) must render NO key at all, since MSAB treats an unset var as true —
# a present key would read as "deliberately configured" to anyone grepping
# the instance env even though it changed nothing.
# -----------------------------------------------------------------------------
run "http_ingest_stays_enabled_by_default_and_renders_no_key" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.event_http_ingest_enabled == true
    error_message = "event_http_ingest_enabled must default to true — HTTP ingest ships inert (unretired) until an operator deliberately flips it"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "\nEVENT_HTTP_INGEST_ENABLED=")
    error_message = "With the default (true) the env file must carry no EVENT_HTTP_INGEST_ENABLED key at all — rendering it would make a no-op look like a deliberate change"
  }
}

# -----------------------------------------------------------------------------
# ARMED (retired): explicitly setting it false must render the key so MSAB
# returns 410 on POST /api/events.
# -----------------------------------------------------------------------------
run "http_ingest_disabled_renders_the_key" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    event_http_ingest_enabled = false
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nEVENT_HTTP_INGEST_ENABLED=false\n")
    error_message = "event_http_ingest_enabled = false must render EVENT_HTTP_INGEST_ENABLED=false into the instance env — without it MSAB keeps accepting HTTP ingest despite the operator's intent to retire it"
  }
}
