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
resource "aws_sns_topic_subscription" "msab_endpoints" {
  for_each = toset(var.msab_endpoint_urls)

  topic_arn = aws_sns_topic.msab_events.arn
  protocol  = "https"
  endpoint  = each.value

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
