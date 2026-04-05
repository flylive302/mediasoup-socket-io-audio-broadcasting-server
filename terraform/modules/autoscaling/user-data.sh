#!/bin/bash
# =============================================================================
# FlyLive Audio Server — EC2 User Data (ASG Bootstrap Script)
# =============================================================================
# Runs on first boot to install Docker, pull the image from ECR, start the app,
# and install the lifecycle drain service for graceful ASG termination.
# Variables are injected by Terraform templatefile().
# =============================================================================

set -euo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

echo "=== Starting MSAB ASG bootstrap ==="

# --- System Updates ---
apt-get update -qq
apt-get upgrade -y -qq

# --- Install Docker ---
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# --- Install AWS CLI v2 (for ECR login + lifecycle hook completion) ---
apt-get install -y unzip
curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
cd /tmp && unzip -q awscliv2.zip && ./aws/install && cd /
rm -rf /tmp/awscliv2.zip /tmp/aws

# --- Kernel Tuning for WebRTC ---
cat >> /etc/sysctl.conf << 'EOF'
# BBR congestion control (better TCP for WebSocket)
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# UDP buffer sizes (26MB — prevents drops under WebRTC load)
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576

# File descriptor limits
fs.file-max = 1048576

# TCP keepalive (detect dead WebSocket connections)
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# Connection tracking table size
net.netfilter.nf_conntrack_max = 1048576
EOF

sysctl -p

# --- File Descriptor Limits ---
cat >> /etc/security/limits.conf << 'EOF'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

# --- Disable conntrack for WebRTC UDP (massive perf win) ---
iptables -t raw -A PREROUTING -p udp --dport ${rtc_min_port}:${rtc_max_port} -j NOTRACK 2>/dev/null || true
iptables -t raw -A OUTPUT -p udp --sport ${rtc_min_port}:${rtc_max_port} -j NOTRACK 2>/dev/null || true

# --- Get instance metadata ---
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)

echo "Public IP: $PUBLIC_IP"

# --- Pull Image from ECR ---
APP_DIR="/opt/msab"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# Extract ECR registry from repo URL (everything before the first /)
ECR_REGISTRY=$(echo "${ecr_repo_url}" | cut -d'/' -f1)

# Authenticate Docker with ECR (uses instance IAM role)
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Pull the pinned image
docker pull ${ecr_repo_url}:${image_tag}

# --- Fetch Secrets from SSM Parameter Store ---
# Secrets are KMS-encrypted in SSM and never written to disk.
# They are passed directly to Docker via -e flags.
SSM_PREFIX="/${project_name}"
REGION="${region}"

fetch_ssm() {
  aws ssm get-parameter \
    --name "$SSM_PREFIX/$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text \
    --region "$REGION" 2>/dev/null || echo ""
}

SECRET_JWT=$(fetch_ssm "jwt-secret")
SECRET_INTERNAL_KEY=$(fetch_ssm "laravel-internal-key")
SECRET_SESSION=$(fetch_ssm "session-secret")
SECRET_TURN_API_KEY=$(fetch_ssm "cloudflare-turn-api-key")
SECRET_REDIS_AUTH=$(fetch_ssm "redis-auth-token")

# --- Create .env file (NON-SENSITIVE config only) ---
cat > .env << ENVEOF
NODE_ENV=production
PORT=${app_port}
LOG_LEVEL=info

# Redis (host/port only — password passed via docker -e)
REDIS_HOST=${redis_host}
REDIS_PORT=${redis_port}
REDIS_DB=3
REDIS_TLS=true

# Laravel
LARAVEL_API_URL=${laravel_api_url}

# MediaSoup
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=$PUBLIC_IP
MEDIASOUP_RTC_MIN_PORT=${rtc_min_port}
MEDIASOUP_RTC_MAX_PORT=${rtc_max_port}

# Workers: vCPU - 1 (reserve 1 for Node.js event loop)
MEDIASOUP_NUM_WORKERS=3

# Limits
MAX_ROOMS_PER_WORKER=100
MAX_LISTENERS_PER_DISTRIBUTION_ROUTER=700

# Security
CORS_ORIGINS=${cors_origins}

# Laravel Events
MSAB_EVENTS_CHANNEL=flylive:msab:events
MSAB_EVENTS_ENABLED=true

# CloudWatch (enabled in production)
CLOUDWATCH_ENABLED=true

# Node.js memory limit (prevents OOM from killing the entire host)
NODE_OPTIONS=--max-old-space-size=2048

# AWS Region (for cross-region room routing)
AWS_REGION=${region}

# SFU Cascade
CASCADE_ENABLED=${cascade_enabled}
CASCADE_THRESHOLD=1800
PUBLIC_IP=$PUBLIC_IP

# ICE Servers — Cloudflare Realtime TURN (dynamic credentials)
CLOUDFLARE_TURN_KEY_ID=${cloudflare_turn_key_id}
ENVEOF

# --- Run Container ---
# Secrets passed via -e flags (from SSM), non-sensitive config via --env-file
# NOTE: awslogs Docker log driver rejected awslogs-stream-prefix on Docker 29.x/Ubuntu 24.04.
# Using json-file with rotation instead. CloudWatch shipping via CW Agent can be added later.
docker run -d \
  --name msab \
  --restart unless-stopped \
  --network host \
  --memory=7g \
  --memory-swap=7g \
  --log-driver=json-file \
  --log-opt max-size=100m \
  --log-opt max-file=5 \
  --env-file .env \
  -e "JWT_SECRET=$SECRET_JWT" \
  -e "LARAVEL_INTERNAL_KEY=$SECRET_INTERNAL_KEY" \
  -e "INTERNAL_API_KEY=$SECRET_INTERNAL_KEY" \
  -e "SESSION_SECRET=$SECRET_SESSION" \
  -e "CLOUDFLARE_TURN_API_KEY=$SECRET_TURN_API_KEY" \
  -e "REDIS_PASSWORD=$SECRET_REDIS_AUTH" \
  ${ecr_repo_url}:${image_tag}

# --- Wait for app health + complete launch lifecycle hook ---
# Ensures ASG only marks instance InService AFTER the app is confirmed healthy.
# Without this, the 300s hook timeout may expire before the app is ready (especially
# with cross-region ECR pulls), causing health-check-fail → replace loops.
echo "Waiting for /health endpoint..."
HEALTH_MAX_WAIT=120
HEALTH_ELAPSED=0

while [ $HEALTH_ELAPSED -lt $HEALTH_MAX_WAIT ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${app_port}/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Health check passed (HTTP $HTTP_CODE)"
    break
  fi
  echo "  ⏳ Health check: HTTP $HTTP_CODE (${HEALTH_ELAPSED}s/${HEALTH_MAX_WAIT}s)"
  sleep 5
  HEALTH_ELAPSED=$((HEALTH_ELAPSED + 5))
done

if [ $HEALTH_ELAPSED -ge $HEALTH_MAX_WAIT ]; then
  echo "⚠️ Health check did not pass in ${HEALTH_MAX_WAIT}s — continuing anyway (hook default will apply)"
fi

# Complete the ASG launch lifecycle hook explicitly
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
ASG_NAME=$(aws autoscaling describe-auto-scaling-instances \
  --instance-ids "$INSTANCE_ID" --region "${region}" \
  --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text 2>/dev/null || echo "")

if [ -n "$ASG_NAME" ] && [ "$ASG_NAME" != "None" ]; then
  echo "Completing launch lifecycle hook for instance $INSTANCE_ID in ASG $ASG_NAME..."
  aws autoscaling complete-lifecycle-action \
    --lifecycle-hook-name "msab-launch-hook" \
    --auto-scaling-group-name "$ASG_NAME" \
    --lifecycle-action-result "CONTINUE" \
    --instance-id "$INSTANCE_ID" \
    --region "${region}" 2>/dev/null && \
    echo "✅ Launch lifecycle hook completed" || \
    echo "⚠️ Launch lifecycle hook completion failed (may have already timed out)"
else
  echo "⚠️ Could not determine ASG name — skipping lifecycle hook completion"
fi

# --- Install Lifecycle Drain Service ---
# AUDIT-017 FIX: Embed drain script inline (removes GitHub and Docker cp dependencies)
mkdir -p "$APP_DIR/scripts/aws"
cat > "$APP_DIR/scripts/aws/lifecycle-drain.sh" << 'DRAINEOF'
#!/bin/bash
set -euo pipefail

APP_PORT="$${MSAB_PORT:-3030}"
INTERNAL_KEY="$${LARAVEL_INTERNAL_KEY:-}"
POLL_INTERVAL=10
DRAIN_POLL=5
MAX_DRAIN_WAIT=900
LOG_TAG="lifecycle-drain"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [$LOG_TAG] $*"; }

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

while true; do
  LIFECYCLE_STATE=$(aws autoscaling describe-auto-scaling-instances \
    --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'AutoScalingInstances[0].LifecycleState' --output text 2>/dev/null || echo "Unknown")

  if [ "$LIFECYCLE_STATE" = "Terminating:Wait" ]; then
    log "Termination detected! Lifecycle state: $LIFECYCLE_STATE"

    ASG_NAME=$(aws autoscaling describe-auto-scaling-instances \
      --instance-ids "$INSTANCE_ID" --region "$REGION" \
      --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text 2>/dev/null)

    log "ASG: $ASG_NAME — triggering drain on MSAB..."

    DRAIN_RESPONSE=$(curl -s -X POST \
      -H "X-Internal-Key: $INTERNAL_KEY" \
      "http://localhost:$APP_PORT/admin/drain?timeout=$((MAX_DRAIN_WAIT - 60))" 2>/dev/null || echo '{"status":"error"}')
    log "Drain response: $DRAIN_RESPONSE"

    ELAPSED=0
    while [ $ELAPSED -lt $MAX_DRAIN_WAIT ]; do
      STATUS=$(curl -s -H "X-Internal-Key: $INTERNAL_KEY" "http://localhost:$APP_PORT/admin/status" 2>/dev/null || echo '{}')
      DRAINED=$(echo "$STATUS" | grep -o '"drained":true' || true)
      ROOMS=$(echo "$STATUS" | grep -o '"rooms":[0-9]*' | grep -o '[0-9]*' || echo "?")

      if [ -n "$DRAINED" ]; then
        log "Instance drained (rooms=$ROOMS) — completing lifecycle action"
        break
      fi

      log "Waiting for drain... rooms=$ROOMS elapsed=$${ELAPSED}s/$${MAX_DRAIN_WAIT}s"
      sleep $DRAIN_POLL
      ELAPSED=$((ELAPSED + DRAIN_POLL))
    done

    if [ $ELAPSED -ge $MAX_DRAIN_WAIT ]; then
      log "Drain timeout reached — force-completing lifecycle action"
    fi

    aws autoscaling complete-lifecycle-action \
      --lifecycle-hook-name "msab-terminate-hook" \
      --auto-scaling-group-name "$ASG_NAME" \
      --lifecycle-action-result "CONTINUE" \
      --instance-id "$INSTANCE_ID" --region "$REGION" 2>/dev/null

    log "Lifecycle action completed — ASG will terminate this instance"
    exit 0
  fi

  sleep $POLL_INTERVAL
done
DRAINEOF

cat > /etc/systemd/system/msab-lifecycle.service << 'SVCEOF'
[Unit]
Description=MSAB ASG Lifecycle Drain Monitor
After=docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=/opt/msab/scripts/aws/lifecycle-drain.sh
EnvironmentFile=/opt/msab/.env
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

chmod +x /opt/msab/scripts/aws/lifecycle-drain.sh
systemctl daemon-reload
systemctl enable msab-lifecycle
systemctl start msab-lifecycle

echo "=== MSAB ASG bootstrap complete ==="
echo "Health check: http://$PUBLIC_IP:${app_port}/health"
