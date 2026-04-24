# =============================================================================
# SNS Module — Event Bus for Laravel → MSAB events
# =============================================================================

# --- SNS Topic ---
resource "aws_sns_topic" "msab_events" {
  name = "${var.project_name}-msab-events"

  tags = {
    Name    = "${var.project_name}-msab-events"
    Project = var.project_name
  }
}

# --- HTTPS Subscription (one per regional MSAB endpoint) ---
# Each endpoint URL includes the internal key as a query parameter for authentication.
# SNS HTTPS subscriptions do not support custom request headers, so the key is passed
# in the URL. The /api/events route reads it from either the X-Internal-Key header
# (for direct Laravel POST) or the ?key= query parameter (for SNS delivery).
resource "aws_sns_topic_subscription" "msab_endpoints" {
  for_each = var.msab_endpoint_urls

  topic_arn = aws_sns_topic.msab_events.arn
  protocol  = "https"
  endpoint  = "${each.value}?key=${var.laravel_internal_key}"

  # Raw message delivery = skip SNS envelope, send just the JSON body
  raw_message_delivery = true

  # Delivery retry policy
  redrive_policy = ""
}

# --- Topic Policy: Allow publish from any authenticated AWS principal ---
resource "aws_sns_topic_policy" "msab_events" {
  arn = aws_sns_topic.msab_events.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowPublishFromAccount"
        Effect    = "Allow"
        Principal = { AWS = var.aws_account_id }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.msab_events.arn
      }
    ]
  })
}
