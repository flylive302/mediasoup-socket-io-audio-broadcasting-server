# =============================================================================
# Alerting module — global SNS topic (ticket 32)
# =============================================================================
# Module-scoped run against ./modules/alerting directly, with a mocked aws
# provider — offline, no API calls, no cost, no credentials (established
# pattern, see tests/ssm_kms.tftest.hcl). Asserts the ships-inert switch:
# no alert_email => no subscription; an email => exactly one, protocol
# "email", endpoint matching; and the fixed topic name convention.
# =============================================================================

mock_provider "aws" {}

run "no_email_means_zero_subscriptions" {
  command = plan

  module {
    source = "./modules/alerting"
  }

  variables {
    project_name = "flylive-audio"
    # alert_email left at its default ("") — ships inert.
  }

  assert {
    condition     = length(aws_sns_topic_subscription.email) == 0
    error_message = "alert_email = \"\" must plan zero subscriptions — the topic exists but nobody is subscribed, so nothing can page anyone by accident"
  }
}

run "email_set_creates_exactly_one_email_subscription" {
  command = plan

  module {
    source = "./modules/alerting"
  }

  variables {
    project_name = "flylive-audio"
    alert_email  = "oncall@flyliveapp.com"
  }

  assert {
    condition     = length(aws_sns_topic_subscription.email) == 1
    error_message = "Setting alert_email must plan exactly one subscription"
  }

  assert {
    condition     = aws_sns_topic_subscription.email[0].protocol == "email"
    error_message = "The subscription protocol must be \"email\""
  }

  assert {
    condition     = aws_sns_topic_subscription.email[0].endpoint == "oncall@flyliveapp.com"
    error_message = "The subscription endpoint must match var.alert_email"
  }
}

run "topic_name_follows_project_name_convention" {
  command = plan

  module {
    source = "./modules/alerting"
  }

  variables {
    project_name = "flylive-audio"
  }

  assert {
    condition     = aws_sns_topic.alerts.name == "flylive-audio-alerts"
    error_message = "Topic name must be \"${var.project_name}-alerts\" — this is the single global alerting topic every region + module.queues shares"
  }
}
