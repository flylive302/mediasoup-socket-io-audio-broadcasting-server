# =============================================================================
# Alerting Module — GLOBAL SNS topic for all operational alarms (ticket 32)
# =============================================================================
# WHY THIS LIVES HERE AND NOT INSIDE modules/cloudwatch (regional):
#
# 1. Dependency cycle. modules/cloudwatch is instantiated PER REGION by
#    modules/region. module.queues (root main.tf) is GLOBAL and its alarms
#    need alarm_actions wired to this topic. If the topic lived inside the
#    regional cloudwatch module, wiring queues -> that topic would require
#    queues -> region -> iam -> queues (root main.tf's `module.iam` already
#    consumes `module.queues.queue_arn`, and `module.region_mumbai` consumes
#    `module.iam` outputs) — a cycle Terraform cannot resolve. Hoisting the
#    topic to its own global module breaks the cycle: queues and region both
#    depend on modules/alerting, and modules/alerting depends on neither.
#
# 2. Name collision (region axis). The topic name is
#    "${local.env_prefix}-alerts" — fixed per environment, not
#    region-qualified. If it were created once per region, enabling a second
#    region (Frankfurt/Singapore — see root main.tf enabled_regions) would
#    make every region try to create the SAME topic name and collide. (The
#    separate staging/production collision on this same name — ticket 31 /
#    decision D3 — is already fixed: the name is env-qualified via
#    local.env_prefix, so the two environments no longer collide.)
#
# 3. One operator, one inbox. There is exactly one on-call surface for this
#    project. A single global topic is the correct shape on the merits, not
#    just a workaround for (1) and (2) — every region's alarms and the global
#    queues module should page the same place.
#
# If a future session is tempted to move this back into modules/cloudwatch
# "to keep alarms and their topic together": don't. That reintroduces the
# cycle in point 1 and the collision in point 2. Keep this module global.
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  # Ticket 31 / decision D3: every runtime resource NAME is qualified by the
  # environment so staging and production can coexist in AWS account
  # 505307260926 (ADR 0028). Deterministic from var.environment — full token,
  # no abbreviation map (all names verified inside AWS length limits).
  # TAGS keep using var.project_name; only NAMES take the prefix.
  env_prefix = "${var.project_name}-${var.environment}"
}

resource "aws_sns_topic" "alerts" {
  name = "${local.env_prefix}-alerts"

  tags = {
    Project = var.project_name
  }
}

# Ships-inert switch: with var.alert_email unset (""), the topic exists but
# nobody is subscribed to it, so nothing can page anyone by accident. Alarms
# can be wired to the topic ARN safely at any time — the topic is a dead
# letter drop until an operator deliberately sets alert_email.
#
# Note for whoever sets alert_email for the first time: SNS email
# subscriptions start in "PendingConfirmation" state. AWS sends a
# confirmation link to the address, and the subscription delivers nothing
# until a human clicks it. That manual step is deliberate — it is SNS's
# built-in proof the inbox is real and watched, not a wart to work around.
resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
