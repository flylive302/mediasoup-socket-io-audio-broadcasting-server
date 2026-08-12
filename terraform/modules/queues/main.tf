# =============================================================================
# Queues Module — SQS FIFO bridge for Laravel → MSAB economy events (ticket 25)
# =============================================================================
# Shape decided by ADR 0029 (docs/adr/DECISIONS.md, output of ticket 05):
# ONE FIFO queue for every event class. The producer (ticket 27) sets:
#   MessageGroupId          = "room:{room_id}" | "user:{user_id}" | "broadcast"
#   MessageDeduplicationId  = sha256(correlation_id, event, user_id, room_id,
#                             canonical(payload)) — the SAME composition as
#                             MSAB's application dedup key (ticket 07). NEVER
#                             bare correlation_id: room.member_removed and
#                             room.member_role_changed are dual-emitted
#                             (user-targeted + room-targeted) with one
#                             correlation_id, and a correlation-only id would
#                             silently drop one of the pair.
#
# INERT BY DESIGN until cutover — the queue exists, the consumer (ticket 26)
# is off without EVENT_QUEUE_URL, the producer (ticket 27) is off unless
# MSAB_TRANSPORT=sqs; production behaviour is unchanged. The SNS topic that
# preceded this bridge was removed by ticket 28 (as ticket 25 scheduled).
#
# DLQ REPLAY (operator, documented per ticket 25 AC):
#   1. Inspect:  aws sqs receive-message --queue-url <dlq-url> \
#                  --visibility-timeout 0 --max-number-of-messages 10
#   2. Replay everything back onto the main queue (managed redrive):
#                aws sqs start-message-move-task --source-arn <dlq-arn>
#      (omit DestinationArn — messages return to their source queue;
#       list/cancel with list-message-move-tasks / cancel-message-move-task)
# The end-to-end demonstration is APPLY-GATED — nothing is applied to AWS yet;
# run it at first apply per the ticket's operator note.
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

# --- Dead-letter queue (FIFO — a FIFO source requires a FIFO DLQ) ---
resource "aws_sqs_queue" "msab_events_dlq" {
  name       = "${local.env_prefix}-msab-events-dlq.fifo"
  fifo_queue = true

  # Dedup ids arrive with the message; no content-based fallback here either.
  content_based_deduplication = false

  # 14 days (maximum) — a dead-lettered economy event is evidence AND money;
  # the operator needs the longest window AWS allows to notice, diagnose and
  # replay before SQS deletes it.
  message_retention_seconds = 1209600

  tags = {
    Name    = "${local.env_prefix}-msab-events-dlq"
    Project = var.project_name
  }
}

# --- Main event queue ---
resource "aws_sqs_queue" "msab_events" {
  name       = "${local.env_prefix}-msab-events.fifo"
  fifo_queue = true

  # ADR 0029: the producer supplies an explicit MessageDeduplicationId (the
  # ticket-07 content hash). Content-based dedup would hash the body alone and
  # collapse the dual-emit pairs, so it stays OFF.
  content_based_deduplication = false

  # Plain FIFO throughput (300 TPS / 3,000 batched — AWS SQS quotas doc,
  # cited in ADR 0029) vs ~3.1 msg/s current volume: two orders of magnitude
  # of headroom. High-throughput mode deliberately NOT enabled.
  deduplication_scope   = "queue"
  fifo_throughput_limit = "perQueue"

  # 4 days (the SQS default, made explicit): if the consumer is down that
  # long the alarm below fired ~96 hours earlier.
  message_retention_seconds = 345600

  # Consumer budget per message: MSAB routes an event to local sockets in
  # milliseconds; 60s covers a slow instance without stalling a message
  # group for minutes when a consumer dies mid-flight.
  visibility_timeout_seconds = 60

  # maxReceiveCount = 5: transient consumer failures (restart, brief Redis
  # blip) get five chances; a message that fails five times is systematically
  # poisonous and belongs in the DLQ for a human, not in the group's way —
  # under FIFO, a stuck head-of-group blocks every message behind it.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.msab_events_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Name    = "${local.env_prefix}-msab-events"
    Project = var.project_name
  }
}

# Only the main queue may dead-letter into this DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "msab_events_dlq" {
  queue_url = aws_sqs_queue.msab_events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.msab_events.arn]
  })
}

# =============================================================================
# Alarms — thresholds stated with their reason. Notification actions are
# wired as code (ticket 32): alarm_actions/ok_actions point at the global
# modules/alerting topic via var.alerts_topic_arn when the caller supplies
# one, and stay empty (visibility-only) when it doesn't — same ships-inert
# pattern as modules/autoscaling's alarm_notification_topic_arn.
# =============================================================================

# Depth: at the ~3.1 msg/s average (ADR 0029), 500 visible messages is ~2.7
# minutes of sustained backlog — the consumer is down or drowning, not bursting.
resource "aws_cloudwatch_metric_alarm" "queue_depth" {
  alarm_name          = "${local.env_prefix}-msab-events-depth"
  alarm_description   = "Main event queue backlog: consumer down or too slow (500 msgs ≈ minutes of events at current volume)"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.msab_events.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 500
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alerts_topic_arn == "" ? [] : [var.alerts_topic_arn]
  ok_actions    = var.alerts_topic_arn == "" ? [] : [var.alerts_topic_arn]

  tags = { Project = var.project_name }
}

# Age of oldest message: 300s means an event a user triggered five minutes ago
# still hasn't reached their screen — economy events are user-visible state
# (balances, seats), so minutes of staleness is an incident, not a backlog.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.env_prefix}-msab-events-age"
  alarm_description   = "Oldest queued event exceeds 5 minutes — user-visible economy state is stale"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.msab_events.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alerts_topic_arn == "" ? [] : [var.alerts_topic_arn]
  ok_actions    = var.alerts_topic_arn == "" ? [] : [var.alerts_topic_arn]

  tags = { Project = var.project_name }
}

# DLQ: a single dead-lettered message is already a lost user-visible event
# awaiting replay — threshold is presence (>= 1), not volume.
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  alarm_name          = "${local.env_prefix}-msab-events-dlq-messages"
  alarm_description   = "Dead-letter queue is non-empty: an economy event failed 5 deliveries and needs inspection + replay (see module header)"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.msab_events_dlq.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alerts_topic_arn == "" ? [] : [var.alerts_topic_arn]
  ok_actions    = var.alerts_topic_arn == "" ? [] : [var.alerts_topic_arn]

  tags = { Project = var.project_name }
}
