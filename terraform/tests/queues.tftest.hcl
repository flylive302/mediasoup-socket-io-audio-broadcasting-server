# =============================================================================
# Ticket 25 — SQS FIFO event bridge: redrive policy, maxReceiveCount, alarm
# thresholds and IAM-based access are asserted so a re-apply cannot silently
# drift them. Shape per ADR 0029.
# =============================================================================
# Mocked aws provider — offline, no API calls, no credentials (established
# pattern, see tests/ssm_kms.tftest.hcl). The DLQ arn is Computed and the main
# queue's redrive_policy references it, so the mock supplies a concrete arn.
# =============================================================================

mock_provider "aws" {
  mock_resource "aws_sqs_queue" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sqs:ap-south-1:111111111111:flylive-audio-production-msab-events-dlq.fifo"
    }
  }
}

run "queue_is_fifo_with_explicit_dedup_and_redrive" {
  command = plan

  module {
    source = "./modules/queues"
  }

  variables {
    project_name = "flylive-audio"
    environment  = "production"
  }

  assert {
    condition     = aws_sqs_queue.msab_events.fifo_queue == true && aws_sqs_queue.msab_events_dlq.fifo_queue == true
    error_message = "Both the main queue and the DLQ must be FIFO (ADR 0029 — ordering is the point; a FIFO source requires a FIFO DLQ)"
  }

  assert {
    condition     = aws_sqs_queue.msab_events.content_based_deduplication == false && aws_sqs_queue.msab_events_dlq.content_based_deduplication == false
    error_message = "Content-based dedup must stay OFF — the producer supplies the ticket-07 content hash as MessageDeduplicationId; body-hash dedup would collapse the dual-emit pairs"
  }

  assert {
    condition     = strcontains(aws_sqs_queue.msab_events.redrive_policy, "\"maxReceiveCount\":5")
    error_message = "Redrive policy must dead-letter after exactly 5 receives (stated in the module: transient failures retry, poison messages stop blocking their FIFO group)"
  }

  assert {
    condition     = aws_sqs_queue.msab_events_dlq.message_retention_seconds == 1209600
    error_message = "DLQ retention must be the 14-day maximum — dead-lettered economy events need the longest window AWS allows for diagnosis + replay"
  }

  assert {
    condition     = aws_sqs_queue.msab_events.fifo_throughput_limit == "perQueue" && aws_sqs_queue.msab_events.deduplication_scope == "queue"
    error_message = "High-throughput mode must stay OFF (ADR 0029: ~3.1 msg/s vs a 300 TPS plain-FIFO ceiling — revisit near ~100 msg/s)"
  }
}

run "queue_alarms_have_stated_thresholds_and_are_wired_to_alerts_topic" {
  command = plan

  module {
    source = "./modules/queues"
  }

  variables {
    project_name     = "flylive-audio"
    environment      = "production"
    alerts_topic_arn = "arn:aws:sns:ap-south-1:111111111111:flylive-audio-production-alerts"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.queue_depth.threshold == 500 && aws_cloudwatch_metric_alarm.queue_depth.metric_name == "ApproximateNumberOfMessagesVisible"
    error_message = "Depth alarm must fire at 500 visible messages (~minutes of sustained backlog at current volume)"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.queue_age.threshold == 300 && aws_cloudwatch_metric_alarm.queue_age.metric_name == "ApproximateAgeOfOldestMessage"
    error_message = "Age alarm must fire at 300s — economy events are user-visible state; 5 minutes of staleness is an incident"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_messages.threshold == 0 && aws_cloudwatch_metric_alarm.dlq_messages.comparison_operator == "GreaterThanThreshold"
    error_message = "DLQ alarm must fire on PRESENCE (>0) — one dead-lettered message is already a lost user-visible event"
  }

  # Ticket 32: when alerts_topic_arn is supplied, all three alarms must wire
  # exactly one alarm_action and one ok_action, both equal to that topic ARN.
  # alarm_actions/ok_actions are aws_cloudwatch_metric_alarm's set(string)
  # attributes — sets have no index, so equality is checked via toset(...).
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.queue_depth.alarm_actions) == 1 && aws_cloudwatch_metric_alarm.queue_depth.alarm_actions == toset([var.alerts_topic_arn]) && length(aws_cloudwatch_metric_alarm.queue_depth.ok_actions) == 1 && aws_cloudwatch_metric_alarm.queue_depth.ok_actions == toset([var.alerts_topic_arn])
    error_message = "queue_depth alarm must wire alarm_actions/ok_actions to the alerts topic when alerts_topic_arn is supplied"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.queue_age.alarm_actions) == 1 && aws_cloudwatch_metric_alarm.queue_age.alarm_actions == toset([var.alerts_topic_arn]) && length(aws_cloudwatch_metric_alarm.queue_age.ok_actions) == 1 && aws_cloudwatch_metric_alarm.queue_age.ok_actions == toset([var.alerts_topic_arn])
    error_message = "queue_age alarm must wire alarm_actions/ok_actions to the alerts topic when alerts_topic_arn is supplied"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dlq_messages.alarm_actions) == 1 && aws_cloudwatch_metric_alarm.dlq_messages.alarm_actions == toset([var.alerts_topic_arn]) && length(aws_cloudwatch_metric_alarm.dlq_messages.ok_actions) == 1 && aws_cloudwatch_metric_alarm.dlq_messages.ok_actions == toset([var.alerts_topic_arn])
    error_message = "dlq_messages alarm must wire alarm_actions/ok_actions to the alerts topic when alerts_topic_arn is supplied"
  }
}

run "queue_alarms_stay_visibility_only_when_alerts_topic_arn_omitted" {
  command = plan

  module {
    source = "./modules/queues"
  }

  variables {
    project_name = "flylive-audio"
    environment  = "production"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.queue_depth.alarm_actions) == 0 && length(aws_cloudwatch_metric_alarm.queue_age.alarm_actions) == 0 && length(aws_cloudwatch_metric_alarm.dlq_messages.alarm_actions) == 0
    error_message = "Queue alarms must stay visibility-only (no actions) when alerts_topic_arn is not supplied — the ships-inert default"
  }
}

run "queue_access_is_iam_role_based_consume_only" {
  command = plan

  module {
    source = "./modules/iam"
  }

  variables {
    project_name               = "flylive-audio"
    environment                = "production"
    ecr_repository_arn         = "arn:aws:ecr:ap-south-1:000000000000:repository/mock"
    ecr_pull_resource_arn      = "arn:aws:ecr:*:000000000000:repository/mock"
    enable_event_queue_consume = true
    event_queue_arn            = "arn:aws:sqs:ap-south-1:000000000000:flylive-audio-production-msab-events.fifo"
  }

  assert {
    condition     = length(aws_iam_role_policy.sqs_consume) == 1
    error_message = "Queue access must be granted by IAM role policy on the MSAB EC2 role — never a shared secret"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.sqs_consume[0].policy, "sqs:ReceiveMessage") && strcontains(aws_iam_role_policy.sqs_consume[0].policy, "flylive-audio-production-msab-events.fifo")
    error_message = "The SQS policy must be consume-side and scoped to the one msab-events queue ARN"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.sqs_consume[0].policy, "sqs:SendMessage")
    error_message = "The instance role must NOT be able to send — an instance that can write its own economy events is a forgery path (the producer is ticket 27's separate principal)"
  }
}
