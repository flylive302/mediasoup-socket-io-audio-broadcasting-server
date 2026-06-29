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
# Arch-aware: uname -m yields x86_64 / aarch64, which match the AWS CLI zip names exactly.
# Lets one user-data script serve both amd64 and arm64 (Graviton) AMIs.
curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "/tmp/awscliv2.zip"
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

# Persist iptables rules so they survive instance reboots
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
netfilter-persistent save

# --- Get instance metadata ---
# Fail loudly on empty IMDS responses. An empty PUBLIC_IP would silently
# break cascade (no reachable host for cross-instance pipe handshakes) and
# was the latent root cause of the split-brain class of audio bugs — the
# app would default selfId to "unknown" and two such instances would
# collide on Redis CAS ownership.
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
if [ -z "$TOKEN" ]; then
  echo "❌ FATAL: IMDSv2 token request returned empty. Instance metadata service unreachable."
  exit 1
fi

PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
if [ -z "$PUBLIC_IP" ]; then
  echo "❌ FATAL: IMDSv2 returned empty PUBLIC_IP. Cascade requires a public IP for cross-instance pipe handshakes."
  echo "   Verify the instance has a public IPv4 address (subnet, security group, ENI mapping)."
  exit 1
fi

echo "Public IP: $PUBLIC_IP"

# --- Pull Image from ECR ---
APP_DIR="/opt/msab"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# realtime-06: pull from THIS region's local ECR registry (images are replicated
# to every consuming region by aws_ecr_replication_configuration). The repo name is
# identical across regions, so rewrite only the region segment of the source URL.
# PRECONDITION: the image must already be replicated into $ECR_REGION before this
# runs, else the pull fails → ELB health-fail → ASG replace loop. (Sequence:
# apply replication → push to Mumbai → confirm in eu-central-1 → then this change.)
ECR_REGION="${region}"
ECR_REPO_URL=$(echo "${ecr_repo_url}" | sed -E "s/dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/dkr.ecr.$ECR_REGION.amazonaws.com/")
ECR_REGISTRY=$(echo "$ECR_REPO_URL" | cut -d'/' -f1)

# Authenticate Docker with the local ECR registry (uses instance IAM role)
aws ecr get-login-password --region "$ECR_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Pull the pinned image from the local (in-region) registry
docker pull $ECR_REPO_URL:${image_tag}

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
# realtime-09 broadcast HLS R2 keys — optional (only consumed when BROADCAST_HLS_ENABLED);
# intentionally NOT in the critical-secrets gate so a host boots fine with HLS disabled.
SECRET_HLS_R2_ACCESS_KEY_ID=$(fetch_ssm "hls-r2-access-key-id")
SECRET_HLS_R2_SECRET_ACCESS_KEY=$(fetch_ssm "hls-r2-secret-access-key")

# --- Validate critical secrets (fail fast instead of silent empty values) ---
MISSING_SECRETS=0
for SECRET_CHECK in "JWT_SECRET:$SECRET_JWT" "INTERNAL_KEY:$SECRET_INTERNAL_KEY" "REDIS_AUTH:$SECRET_REDIS_AUTH" "SESSION_SECRET:$SECRET_SESSION"; do
  CHECK_NAME="$${SECRET_CHECK%%:*}"
  CHECK_VALUE="$${SECRET_CHECK#*:}"
  if [ -z "$CHECK_VALUE" ]; then
    echo "❌ FATAL: Secret $CHECK_NAME is empty — SSM parameter likely missing in region $REGION"
    MISSING_SECRETS=1
  fi
done

if [ "$MISSING_SECRETS" -eq 1 ]; then
  echo "❌ Bootstrap aborted: critical secrets missing. Check SSM Parameter Store in $REGION."
  echo "   Expected path: $SSM_PREFIX/<secret-name>"
  exit 1
fi

echo "✅ All critical secrets fetched from SSM ($REGION)"

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

# JWT Authentication
# Max age must match Laravel's MSAB JWT expiry (services.msab.jwt_expiry_hours)
JWT_MAX_AGE_SECONDS=${jwt_max_age_seconds}

# Laravel
LARAVEL_API_URL=${laravel_api_url}
LARAVEL_API_TIMEOUT_MS=${laravel_api_timeout_ms}

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

# ICE Servers (STUN/TURN for WebRTC NAT traversal)
ICE_STUN_URLS=${ice_stun_urls}

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

# realtime-08 — interactive↔broadcast flip thresholds (Listener count, hysteresis).
# Default 1500/1000; lower temporarily (e.g. 2/1) in prod.tfvars to smoke-test the
# broadcast tier on a region without 1,500 real Listeners, then restore.
ROOM_BROADCAST_THRESHOLD_UP=${room_broadcast_threshold_up}
ROOM_BROADCAST_THRESHOLD_DOWN=${room_broadcast_threshold_down}

# realtime-09 — broadcast HLS tier (non-sensitive; R2 keys passed via docker -e).
BROADCAST_HLS_ENABLED=${broadcast_hls_enabled}
HLS_R2_ENDPOINT=${hls_r2_endpoint}
HLS_R2_BUCKET=${hls_r2_bucket}
HLS_PUBLIC_BASE_URL=${hls_public_base_url}
ENVEOF

# --- Write secrets env file for lifecycle drain service (not in .env, not in Docker) ---
cat > /opt/msab/.env.secrets << SECRETSEOF
LARAVEL_INTERNAL_KEY=$SECRET_INTERNAL_KEY
MSAB_PORT=${app_port}
SECRETSEOF
chmod 600 /opt/msab/.env.secrets

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
  -e "HLS_R2_ACCESS_KEY_ID=$SECRET_HLS_R2_ACCESS_KEY_ID" \
  -e "HLS_R2_SECRET_ACCESS_KEY=$SECRET_HLS_R2_SECRET_ACCESS_KEY" \
  $ECR_REPO_URL:${image_tag}

# --- Install CloudWatch Agent (ship Docker JSON logs to CloudWatch Logs) ---
wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb \
  -O /tmp/cw-agent.deb
dpkg -i /tmp/cw-agent.deb
rm /tmp/cw-agent.deb

cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWEOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [{
          "file_path": "/var/lib/docker/containers/*/*.log",
          "log_group_name": "/flylive-audio/msab",
          "log_stream_name": "{instance_id}",
          "timezone": "UTC",
          "multi_line_start_pattern": "^\\{"
        }]
      }
    }
  }
}
CWEOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s

echo "✅ CloudWatch Agent started — logs → /flylive-audio/msab"

# --- Wait for app health + complete launch lifecycle hook ---
# Ensures ASG only marks instance InService AFTER the app is confirmed healthy.
# Without this, the 300s hook timeout may expire before the app is ready (especially
# with cross-region ECR pulls), causing health-check-fail → replace loops.
echo "Waiting for /health endpoint..."
HEALTH_MAX_WAIT=120
HEALTH_ELAPSED=0

while [ $HEALTH_ELAPSED -lt $HEALTH_MAX_WAIT ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%%{http_code}" "http://localhost:${app_port}/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Health check passed (HTTP $HTTP_CODE)"
    break
  fi
  echo "  ⏳ Health check: HTTP $HTTP_CODE ($${HEALTH_ELAPSED}s/$${HEALTH_MAX_WAIT}s)"
  sleep 5
  HEALTH_ELAPSED=$((HEALTH_ELAPSED + 5))
done

if [ $HEALTH_ELAPSED -ge $HEALTH_MAX_WAIT ]; then
  echo "⚠️ Health check did not pass in $${HEALTH_MAX_WAIT}s — continuing anyway (hook default will apply)"
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
EnvironmentFile=/opt/msab/.env.secrets
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
