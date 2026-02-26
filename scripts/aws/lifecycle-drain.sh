#!/bin/bash
# =============================================================================
# ASG Lifecycle Hook — Drain Script
# =============================================================================
# Runs as a systemd service on EC2 instances in an Auto Scaling Group.
# Polls for termination lifecycle hooks, triggers drain mode on MSAB,
# waits for rooms to close, then completes the lifecycle action.
#
# Prerequisites:
#   - IAM instance profile with autoscaling:* permissions
#   - AWS CLI v2 installed
#   - MSAB running on localhost:3030
# =============================================================================

set -euo pipefail

# --- Configuration ---
APP_PORT="${MSAB_PORT:-3030}"
INTERNAL_KEY="${LARAVEL_INTERNAL_KEY:-}"
POLL_INTERVAL=10     # seconds between lifecycle state checks
DRAIN_POLL=5         # seconds between drain status checks
MAX_DRAIN_WAIT=900   # 15 minutes max drain wait (matches lifecycle hook timeout)
LOG_TAG="lifecycle-drain"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [$LOG_TAG] $*"
}

# --- Get Instance Metadata (IMDSv2) ---
get_metadata() {
  local path="$1"
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null)
  curl -s -H "X-aws-ec2-metadata-token: $token" \
    "http://169.254.169.254/latest/meta-data/$path" 2>/dev/null
}

INSTANCE_ID=$(get_metadata "instance-id")
REGION=$(get_metadata "placement/region")

if [ -z "$INSTANCE_ID" ] || [ -z "$REGION" ]; then
  log "ERROR: Could not get instance metadata. Not running on EC2?"
  exit 1
fi

log "Started lifecycle drain monitor for instance=$INSTANCE_ID region=$REGION"

# --- Main Loop: Poll for Termination ---
while true; do
  # Check if this instance is in a Terminating:Wait lifecycle state
  LIFECYCLE_STATE=$(aws autoscaling describe-auto-scaling-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'AutoScalingInstances[0].LifecycleState' \
    --output text 2>/dev/null || echo "Unknown")

  if [ "$LIFECYCLE_STATE" = "Terminating:Wait" ]; then
    log "🔄 Termination detected! Lifecycle state: $LIFECYCLE_STATE"

    # Get the ASG name for completing the lifecycle action
    ASG_NAME=$(aws autoscaling describe-auto-scaling-instances \
      --instance-ids "$INSTANCE_ID" \
      --region "$REGION" \
      --query 'AutoScalingInstances[0].AutoScalingGroupName' \
      --output text 2>/dev/null)

    log "ASG: $ASG_NAME — triggering drain on MSAB..."

    # --- Trigger Drain Mode ---
    DRAIN_RESPONSE=$(curl -s -X POST \
      -H "X-Internal-Key: $INTERNAL_KEY" \
      "http://localhost:$APP_PORT/admin/drain?timeout=$((MAX_DRAIN_WAIT - 60))" 2>/dev/null || echo '{"status":"error"}')

    log "Drain response: $DRAIN_RESPONSE"

    # --- Wait for Drain to Complete ---
    ELAPSED=0
    while [ $ELAPSED -lt $MAX_DRAIN_WAIT ]; do
      STATUS=$(curl -s "http://localhost:$APP_PORT/admin/status" 2>/dev/null || echo '{}')
      DRAINED=$(echo "$STATUS" | grep -o '"drained":true' || true)
      ROOMS=$(echo "$STATUS" | grep -o '"rooms":[0-9]*' | grep -o '[0-9]*' || echo "?")

      if [ -n "$DRAINED" ]; then
        log "✅ Instance drained (rooms=$ROOMS) — completing lifecycle action"
        break
      fi

      log "⏳ Waiting for drain... rooms=$ROOMS elapsed=${ELAPSED}s/${MAX_DRAIN_WAIT}s"
      sleep $DRAIN_POLL
      ELAPSED=$((ELAPSED + DRAIN_POLL))
    done

    if [ $ELAPSED -ge $MAX_DRAIN_WAIT ]; then
      log "⚠️ Drain timeout reached — force-completing lifecycle action"
    fi

    # --- Complete Lifecycle Action ---
    aws autoscaling complete-lifecycle-action \
      --lifecycle-hook-name "msab-terminate-hook" \
      --auto-scaling-group-name "$ASG_NAME" \
      --lifecycle-action-result "CONTINUE" \
      --instance-id "$INSTANCE_ID" \
      --region "$REGION" 2>/dev/null

    log "✅ Lifecycle action completed — ASG will terminate this instance"
    exit 0
  fi

  sleep $POLL_INTERVAL
done
