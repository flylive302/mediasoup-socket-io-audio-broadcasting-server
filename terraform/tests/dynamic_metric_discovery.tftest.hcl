# =============================================================================
# Dynamic metric discovery (ticket 31, seam 1) — rendered-plan assertions
# =============================================================================
# Offline, mocked-provider tests (no API calls, no cost, no credentials) —
# same pattern as tests/drain_window.tftest.hcl and tests/plan_assertions.tftest.hcl.
#
# Design under test (see docs/issues/aws-platform-build/31-dynamic-metric-discovery.md
# "Implementation notes"): every MSAB instance PUSHES its own metrics straight
# to CloudWatch (src/infrastructure/cloudwatch.ts, PutMetricData, namespace
# FlyLive/MSAB, dimensioned by its own InstanceId). There is no central
# scraper/collector to discover targets for, and no single collector whose
# loss can blind the fleet — each instance is its own collector. These tests
# assert the terraform side of that design stays true: the IAM policy scopes
# every instance to self-publish into the shared namespace, and the dashboard
# discovers instances via SEARCH() rather than a hardcoded target list.
# =============================================================================

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }
}

# -----------------------------------------------------------------------------
# modules/cloudwatch/main.tf: aws_cloudwatch_dashboard.msab uses SEARCH() for
# every per-instance widget ("Connections per Instance", "CPU per Instance")
# instead of a hardcoded metrics list keyed on specific instance IDs. This is
# the AC-1 "discovers instances dynamically, no config edit on replacement"
# property rendered into the actual dashboard body.
# -----------------------------------------------------------------------------
# command = apply (not plan): the "Alarm Status" widget embeds
# aws_cloudwatch_metric_alarm.*.arn, which is Computed and unknown under a
# mocked provider until apply — so dashboard_body as a whole is unknown at
# plan time. Same reasoning as tests/ssm_kms.tftest.hcl's apply runs. Nothing
# real is touched: mock_provider fabricates every resource in memory.
run "dashboard_discovers_instances_via_search_not_static_list" {
  command = apply

  module {
    source = "./modules/cloudwatch"
  }

  variables {
    project_name = "flylive-audio"
    aws_region   = "ap-south-1"
    # ticket 32: the SNS topic is now created by the global modules/alerting
    # module, not here — this module only receives its ARN.
    alerts_topic_arn = "arn:aws:sns:ap-south-1:111111111111:flylive-audio-alerts"
  }

  assert {
    condition     = strcontains(aws_cloudwatch_dashboard.msab.dashboard_body, "SEARCH('{FlyLive/MSAB,InstanceId}")
    error_message = "dashboard must discover per-instance metrics via SEARCH() over the InstanceId dimension, not a static instance list"
  }

  # No literal EC2 instance id (i-xxxxxxxx form) may be baked into the
  # dashboard body — that would be exactly the static-target-list failure
  # mode ticket 31 exists to close off.
  assert {
    condition     = !strcontains(aws_cloudwatch_dashboard.msab.dashboard_body, "\"i-")
    error_message = "dashboard body must not hardcode a literal instance id"
  }

  # Fleet alarms query with dimensions = {} against the DIMENSIONLESS stream
  # every instance writes into independently (TIER0 fix, main.tf lines 26-40)
  # — so the alarm keeps working across any fleet replacement without an edit.
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.high_connections.dimensions) == 0
    error_message = "fleet alarms must stay dimensionless so they don't need updating when instances are replaced"
  }
}

# -----------------------------------------------------------------------------
# modules/iam/main.tf: aws_iam_role_policy.cloudwatch_metrics grants every
# instance (via the shared instance profile) cloudwatch:PutMetricData scoped
# to namespace FlyLive/MSAB. Because the policy is on the ROLE, not tied to
# any specific instance ARN, a newly launched instance inherits the exact
# same publish permission with zero terraform/IAM edit — this is what makes
# "replaced or added instance is [collected] with no configuration edit" true
# on the publish side, not just the dashboard side.
# -----------------------------------------------------------------------------
run "instance_role_can_self_publish_metrics_without_per_instance_grant" {
  command = plan

  module {
    source = "./modules/iam"
  }

  variables {
    project_name       = "flylive-audio"
    ecr_repository_arn = "arn:aws:ecr:ap-south-1:111111111111:repository/flylive-audio/msab"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.cloudwatch_metrics.policy, "cloudwatch:PutMetricData")
    error_message = "instance role must be able to self-publish metrics (PutMetricData) — no separate per-instance/collector grant"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.cloudwatch_metrics.policy, "FlyLive/MSAB")
    error_message = "self-publish permission must stay scoped to the FlyLive/MSAB namespace"
  }
}
