#!/bin/bash
# =============================================================================
# FlyLive Audio Server — EC2 User Data (ASG Bootstrap Script)
# =============================================================================
# Runs on first boot to install Docker, pull the image from ECR, install the
# monitoring agent + lifecycle drain service, start the app, and RELEASE THE
# INSTANCE LAST — the launch hook completes only after /health returns 200.
#
# ⚠️ ORDERING IS THE CONTRACT (ticket 19 + aws-production 02), two halves:
#   1. Monitoring agent + drain service install BEFORE `docker run` (ticket 19).
#      The ARM defect was this order reversed: traffic started, the script died,
#      and no drain path existed. Do not move an install below `docker run`
#      "because it's slow".
#   2. The launch lifecycle hook completes (CONTINUE) ONLY after `docker run`
#      succeeded AND /health returned 200 (aws-production 02). Until then the
#      hook is open, so a failure at ANY step — container start and health wait
#      included — ends in ABANDON (the EXIT trap below, or the hook's ABANDON
#      default) and the ASG replaces the instance. Completing the hook any
#      earlier makes the trap's ABANDON a no-op (AWS will not take back a
#      completed hook) — an InService box serving nothing.
#
# Variables are injected by Terraform templatefile().
# =============================================================================

set -euo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

# --- Fail closed on ANY bootstrap failure (ticket 19) ---
# The launch hook's default_result is ABANDON, so even if this trap itself can't
# run (e.g. cloud-init kills the shell), an uncompleted hook still terminates the
# instance at hook expiry instead of putting it InService. The trap just makes
# that fast and removes any partially started container.
on_exit() {
  STATUS=$?
  if [ "$STATUS" -eq 0 ]; then
    exit 0
  fi
  echo "❌ Bootstrap FAILED (exit $STATUS) — failing closed: this instance must never take traffic."
  command -v docker >/dev/null 2>&1 && docker rm -f msab 2>/dev/null || true
  if command -v aws >/dev/null 2>&1; then
    T=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
    IID=$(curl -s -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/instance-id || true)
    ASG=$(aws autoscaling describe-auto-scaling-instances \
      --instance-ids "$IID" --region "${region}" \
      --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text 2>/dev/null || true)
    if [ -n "$ASG" ] && [ "$ASG" != "None" ]; then
      aws autoscaling complete-lifecycle-action \
        --lifecycle-hook-name "msab-launch-hook" \
        --auto-scaling-group-name "$ASG" \
        --lifecycle-action-result "ABANDON" \
        --instance-id "$IID" --region "${region}" 2>/dev/null || true
      echo "   Launch lifecycle hook ABANDONed — the ASG will terminate this instance."
    fi
  fi
  exit "$STATUS"
}
trap on_exit EXIT

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

# --- Assert the public address is genuinely ROUTABLE, not merely present (ticket 19) ---
# A NAT'd, CGNAT'd or link-local address passes the empty-check above but is
# unreachable for cross-instance pipe handshakes — media would silently bind to
# an address nobody can dial (story 61). Reject every non-global range outright.
case "$PUBLIC_IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|169.254.*|127.*|0.*)
    echo "❌ FATAL: PUBLIC_IP=$PUBLIC_IP is not publicly routable (private/CGNAT/link-local range)."
    echo "   Fix the subnet / ENI public-IP mapping — do not let media bind to an unreachable address."
    exit 1
    ;;
esac

echo "Public IP: $PUBLIC_IP"

# --- Instance identity, resolved ONCE at provisioning time (ticket 19) ---
# Written into the .env below as INSTANCE_ID_OVERRIDE, which the app checks
# BEFORE any metadata probe (src/infrastructure/instance-identity.ts). The value
# is the EC2 instance id — the same thing the app's own IMDS probe would return —
# so behaviour is identical, but identity is now explicit configuration: unique
# per instance, stable across container restarts, deterministic, and validated
# here instead of falling back to a hostname at runtime (split-brain risk on a
# fleet sharing one Redis state store).
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
if [ -z "$INSTANCE_ID" ]; then
  echo "❌ FATAL: IMDSv2 returned empty instance-id. A non-unique fallback identity is a split-brain risk."
  exit 1
fi
echo "Instance ID: $INSTANCE_ID"

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
# Secrets are KMS-encrypted in SSM (ticket 16) and reach the container through a
# 0600 env-file written below — never through the docker command line.
SSM_PREFIX="/${name_prefix}"
REGION="${region}"

fetch_ssm() {
  # ⚠️ Sanitize here, once, for all callers. These values are written to a docker
  # --env-file, whose parser is NOT a shell: no quote handling, and a value runs to
  # end of line. A stray CR (a CRLF paste into the SSM console) would end up INSIDE
  # the value. The same file is also read by systemd's EnvironmentFile parser, a
  # third set of rules again. Stripping CR costs nothing and removes the whole class.
  # A value containing a real newline can't be salvaged — it is rejected below.
  aws ssm get-parameter \
    --name "$SSM_PREFIX/$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text \
    --region "$REGION" 2>/dev/null | tr -d '\r' || echo ""
}

SECRET_JWT=$(fetch_ssm "jwt-secret")
SECRET_INTERNAL_KEY=$(fetch_ssm "laravel-internal-key")
SECRET_SESSION=$(fetch_ssm "session-secret")
SECRET_TURN_API_KEY=$(fetch_ssm "cloudflare-turn-api-key")
SECRET_REDIS_AUTH=$(fetch_ssm "redis-auth-token")
# Rotation overlap (ticket 28) — the parameter only exists while a JWT rotation is
# in flight, so an EMPTY value here is the normal steady state, not a failure.
# Deliberately NOT in the critical-secrets gate below for exactly that reason.
SECRET_JWT_PREVIOUS=$(fetch_ssm "jwt-secret-previous")
# realtime-09 broadcast HLS R2 keys — optional (only consumed when BROADCAST_HLS_ENABLED);
# intentionally NOT in the critical-secrets gate so a host boots fine with HLS disabled.
SECRET_HLS_R2_ACCESS_KEY_ID=$(fetch_ssm "hls-r2-access-key-id")
SECRET_HLS_R2_SECRET_ACCESS_KEY=$(fetch_ssm "hls-r2-secret-access-key")
# ticket 39 — per-instance TLS terminator. Deliberately NOT in the
# critical-secrets gate below: absent/empty is the normal steady state
# (no cert provisioned for this environment yet), and the terminator block
# further down fails OPEN on exactly that condition — never aborts boot.
SECRET_TLS_CERT=$(fetch_ssm "tls-certificate")
SECRET_TLS_KEY=$(fetch_ssm "tls-private-key")
SECRET_TLS_CHAIN=$(fetch_ssm "tls-chain")

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

# --- Reject secrets that cannot survive an env-file ---
# A literal newline truncates the value and turns the remainder into a garbage KEY
# line. Docker rejects that at `docker run` — i.e. at boot, inside the launch
# lifecycle hook, on an instance that then health-fails and gets replaced. Fail here
# instead, with a message that names the parameter.
for SECRET_NAME in SECRET_JWT SECRET_JWT_PREVIOUS SECRET_INTERNAL_KEY SECRET_SESSION SECRET_TURN_API_KEY SECRET_REDIS_AUTH SECRET_HLS_R2_ACCESS_KEY_ID SECRET_HLS_R2_SECRET_ACCESS_KEY; do
  if [ "$(printf '%s' "$${!SECRET_NAME}" | wc -l)" -gt 0 ]; then
    echo "❌ FATAL: $SECRET_NAME contains a newline — it cannot be written to a docker --env-file."
    echo "   Fix the SSM parameter value (single line, no CR/LF), then relaunch the instance."
    exit 1
  fi
done

echo "✅ All critical secrets fetched from SSM ($REGION)"

# --- Create .env file (NON-SENSITIVE config only) ---
# Absolute path on purpose: this file is READ by absolute path (docker --env-file, and the
# msab-lifecycle systemd unit's EnvironmentFile). Writing it relative would work only for as
# long as nobody adds a `cd` between here and the docker run — and that failure boots a
# container with zero non-secret config.
cat > /opt/msab/.env << ENVEOF
NODE_ENV=production
PORT=${app_port}
# Same port, second name: the msab-lifecycle systemd unit reads THIS file and the drain
# script looks for MSAB_PORT. Kept here (non-sensitive) so the secrets file below holds
# nothing but secrets.
MSAB_PORT=${app_port}
LOG_LEVEL=info

# Instance identity (ticket 19): explicit configuration, checked by the app BEFORE
# any metadata probe — never a hostname or container-id fallback at runtime.
INSTANCE_ID_OVERRIDE=$INSTANCE_ID

# Redis (host/port only — passwords ride the 0600 secrets env-file below).
# REDIS_* = DURABLE store (money queue, room/seat/block state — noeviction,
# snapshotted). REDIS_CACHE_* = evict-freely store (rate limits, presence,
# socket.io pub/sub). Both are dedicated MSAB ElastiCache groups, so DB 0 —
# the old DB 3 existed only to avoid Laravel on a shared host.
REDIS_HOST=${redis_host}
REDIS_PORT=${redis_port}
REDIS_DB=0
REDIS_TLS=true
REDIS_CACHE_HOST=${redis_cache_host}
REDIS_CACHE_PORT=${redis_cache_port}
REDIS_CACHE_DB=0
REDIS_CACHE_TLS=true

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

# Workers: derived by MSAB's config schema at boot (vCPU - 1, one core
# reserved for the Node.js event loop) — see 02-derive-worker-count-and-assert-vcpu-floor.
# Intentionally NOT set here so both deployment paths (this template and the
# already env-driven Vultr path) agree: an unset value lets the app derive it.


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

# SQS event consumer (ticket 25/26). OMITTED when empty, which is the inert
# state: createQueueConsumer() returns null without EVENT_QUEUE_URL, so no
# consumer runs and the HTTP ingest route is the only transport. Arming this is
# strictly ADDITIVE — EVENT_HTTP_INGEST_ENABLED is untouched and both transports
# share one ingestEnvelope pipeline, so a message can only be routed or
# dead-lettered, never double-delivered (the dedup seam absorbs redelivery).
# The value is module.queues.queue_url, a terraform output — never a tfvars
# literal, so it can never drift from the queue that actually exists.
%{ if event_queue_url != "" ~}
EVENT_QUEUE_URL=${event_queue_url}
%{ endif ~}

# Sentry (env-diff finding 2026-08-18 — Vultr reported, AWS didn't). Omitted
# entirely when the DSN is unset, same contract as the HLS URL vars below.
# SENTRY_RELEASE must be the byte-identical sha-<commit8> the image's
# sourcemaps were uploaded under; image_tag is that tag by construction.
%{ if sentry_dsn != "" ~}
SENTRY_DSN=${sentry_dsn}
SENTRY_RELEASE=${image_tag}
SENTRY_ENVIRONMENT=${sentry_environment}
%{ endif ~}

# CloudWatch (enabled in production)
CLOUDWATCH_ENABLED=true

# Node.js memory limit (prevents OOM from killing the entire host)
NODE_OPTIONS=--max-old-space-size=2048

# AWS Region (for cross-region room routing)
AWS_REGION=${region}

# SFU Cascade
CASCADE_ENABLED=${cascade_enabled}
PUBLIC_IP=$PUBLIC_IP

# ICE Servers — Cloudflare Realtime TURN (dynamic credentials)
CLOUDFLARE_TURN_KEY_ID=${cloudflare_turn_key_id}

# realtime-08 — interactive↔broadcast flip thresholds (Listener count, hysteresis).
# Default 1500/1000; lower temporarily (e.g. 2/1) in prod.tfvars to smoke-test the
# broadcast tier on a region without 1,500 real Listeners, then restore.
ROOM_BROADCAST_THRESHOLD_UP=${room_broadcast_threshold_up}
ROOM_BROADCAST_THRESHOLD_DOWN=${room_broadcast_threshold_down}

# realtime-09 — broadcast HLS tier (non-sensitive; R2 keys ride the secrets env-file).
# URL vars are OMITTED when empty: the app schema is optional-but-must-be-a-URL,
# so `HLS_R2_ENDPOINT=` (empty string) fails z.string().url() and crash-loops the
# container even with the tier disabled (found on the first staging boot).
BROADCAST_HLS_ENABLED=${broadcast_hls_enabled}
%{ if hls_r2_endpoint != "" ~}
HLS_R2_ENDPOINT=${hls_r2_endpoint}
%{ endif ~}
%{ if hls_r2_bucket != "" ~}
HLS_R2_BUCKET=${hls_r2_bucket}
%{ endif ~}
%{ if hls_public_base_url != "" ~}
HLS_PUBLIC_BASE_URL=${hls_public_base_url}
%{ endif ~}
ENVEOF

# --- Write secrets env file (0600) ---
# Consumed twice: as the container's SECOND --env-file, and by the msab-lifecycle
# systemd unit. Secrets ONLY — every non-sensitive value lives in .env above.
# This mirrors the proven production runtime, which runs
# `--env-file /opt/msab/.env --env-file /opt/msab/.secrets` and passes no -e flags
# (docs/runbooks/msab-by-hand-deploy.md). Keeping the shape identical also keeps the
# secrets off the process command line.
touch /opt/msab/.env.secrets
chmod 600 /opt/msab/.env.secrets
cat > /opt/msab/.env.secrets << SECRETSEOF
JWT_SECRET=$SECRET_JWT
JWT_SECRET_PREVIOUS=$SECRET_JWT_PREVIOUS
LARAVEL_INTERNAL_KEY=$SECRET_INTERNAL_KEY
INTERNAL_API_KEY=$SECRET_INTERNAL_KEY
SESSION_SECRET=$SECRET_SESSION
CLOUDFLARE_TURN_API_KEY=$SECRET_TURN_API_KEY
REDIS_PASSWORD=$SECRET_REDIS_AUTH
REDIS_CACHE_PASSWORD=$SECRET_REDIS_AUTH
HLS_R2_ACCESS_KEY_ID=$SECRET_HLS_R2_ACCESS_KEY_ID
HLS_R2_SECRET_ACCESS_KEY=$SECRET_HLS_R2_SECRET_ACCESS_KEY
SECRETSEOF

# --- Install CloudWatch Agent (ship Docker JSON logs to CloudWatch Logs) ---
# ⚠️ BEFORE the container (ticket 19): the old ordering installed this AFTER
# `docker run`, so on ARM the hardcoded amd64 .deb failed dpkg, `set -e` killed
# the script — after traffic, before the drain service existed.
# Arch-aware: dpkg --print-architecture yields amd64 / arm64, matching the CW
# agent's Ubuntu package paths exactly.
CW_ARCH=$(dpkg --print-architecture)
wget -q "https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/$CW_ARCH/latest/amazon-cloudwatch-agent.deb" \
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
          "log_group_name": "/${name_prefix}/msab",
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

echo "✅ CloudWatch Agent started — logs → /${name_prefix}/msab"

# --- Install Lifecycle Drain Service (BEFORE the container — ticket 19) ---
# AUDIT-017 FIX: Embed drain script inline (removes GitHub and Docker cp dependencies)
mkdir -p "$APP_DIR/scripts/aws"
cat > "$APP_DIR/scripts/aws/lifecycle-drain.sh" << 'DRAINEOF'
#!/bin/bash
set -euo pipefail

APP_PORT="$${MSAB_PORT:-3030}"
INTERNAL_KEY="$${LARAVEL_INTERNAL_KEY:-}"
# How often we check whether AWS has moved us to Terminating:Wait. This is DETECTION LAG:
# the hook's heartbeat clock starts when AWS transitions the instance, not when we notice,
# so it is part of the same budget as the drain itself. Rendered, and the hook margin is
# validated to exceed it (see drain_hook_margin_seconds in variables.tf).
POLL_INTERVAL=${lifecycle_poll_interval_seconds}

# --- Drain window: RENDERED by terraform, never a literal (ticket 18 AC #3) ---
# Single source of truth = var.app_drain_ceiling_seconds, which mirrors the app's own
# DRAIN_CEILING_MS in src/index.ts. Do NOT hand-edit these three numbers here.
#   DRAIN_POLL      = how often we re-check drain status
#   MAX_DRAIN_WAIT  = app ceiling + one poll tick. Strictly LESS than the ASG terminate
#                     hook's heartbeat, so this script always completes the lifecycle
#                     action INSIDE the window AWS is holding open — it never sends a
#                     lifecycle heartbeat, so racing hook expiry has no recovery path.
#   DRAIN_REQUEST   = the timeout we ASK the app for. Equals the app's own ceiling; it
#                     must never be lower. The old code asked for MAX_DRAIN_WAIT minus a
#                     60s offset — tuned against a 900s window, that offset carried onto a
#                     150s window asks for 90s, below the 120s the app actually needs.
DRAIN_POLL=${drain_poll_interval_seconds}
MAX_DRAIN_WAIT=${drain_poll_ceiling_seconds}
DRAIN_REQUEST=${drain_request_seconds}
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

%{ if manage_instance_dns ~}
    # --- Per-instance DNS cleanup (ticket 39) — best-effort, never blocks drain ---
    # Files written by the boot-time registration block above, only present
    # when that registration actually succeeded. Their absence (never
    # registered, or the create call failed) is the normal "nothing to clean
    # up" case, not an error.
    if [ -f /opt/msab/.dns-hostname ] && [ -f /opt/msab/.cf-token ]; then
      DNS_HOSTNAME=$(cat /opt/msab/.dns-hostname 2>/dev/null || echo "")
      CF_TOKEN=$(cat /opt/msab/.cf-token 2>/dev/null || echo "")
      if [ -n "$DNS_HOSTNAME" ] && [ -n "$CF_TOKEN" ]; then
        log "Removing DNS record $DNS_HOSTNAME"
        RECORD_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/${cloudflare_zone_id}/dns_records?type=A&name=$DNS_HOSTNAME" \
          -H "Authorization: Bearer $CF_TOKEN" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [ -n "$RECORD_ID" ]; then
          curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${cloudflare_zone_id}/dns_records/$RECORD_ID" \
            -H "Authorization: Bearer $CF_TOKEN" >/dev/null 2>&1 || true
          log "DNS record $DNS_HOSTNAME removed (id=$RECORD_ID)"
        else
          log "WARNING: could not resolve record id for $DNS_HOSTNAME — leaving it, next boot's create will just re-point it"
        fi
      fi
    fi
%{ endif ~}

    ASG_NAME=$(aws autoscaling describe-auto-scaling-instances \
      --instance-ids "$INSTANCE_ID" --region "$REGION" \
      --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text 2>/dev/null)

    log "ASG: $ASG_NAME — triggering drain on MSAB..."

    DRAIN_RESPONSE=$(curl -s -X POST \
      -H "X-Internal-Key: $INTERNAL_KEY" \
      "http://localhost:$APP_PORT/admin/drain?timeout=$DRAIN_REQUEST" 2>/dev/null || echo '{"status":"error"}')
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

# The drain path must be PROVEN alive, not assumed: an EnvironmentFile parse
# failure leaves the unit restart-looping and would otherwise be discovered at
# the first scale-in — the moment it must work. 3s is enough to catch an
# immediate crash (RestartSec=10 means a crashed unit is NOT "active" yet).
sleep 3
if ! systemctl is-active --quiet msab-lifecycle; then
  echo "❌ FATAL: msab-lifecycle drain monitor is not active after start."
  systemctl status msab-lifecycle --no-pager || true
  echo "   Refusing to take traffic without a working drain path."
  exit 1
fi
echo "✅ Drain monitor active (msab-lifecycle)"

# --- Run Container — after every pre-traffic install (ticket 19), with the hook
# still OPEN (aws-production 02): a failed start or failed health wait below exits
# while the launch hook is uncompleted, so the EXIT trap's ABANDON (or the hook's
# ABANDON default) replaces this instance instead of leaving it InService. ---
# ⚠️ This invocation is deliberately flag-for-flag identical to the proven production
# runtime (docs/runbooks/msab-by-hand-deploy.md) — ONLY the substrate differs (ECR
# instead of GHCR, EC2 instead of the Vultr box). Do not "improve" a flag here without
# changing the runbook in the same breath; a silent divergence means AWS is running a
# configuration nothing has ever proven.
#   --memory / --memory-swap: rendered from the instance type's RAM minus the stated host
#     reserve (see locals in main.tf). On c7i.xlarge this is 6144m — the same 6g the live
#     box runs. --memory-swap MUST equal --memory: swap on a mediasoup worker is audible
#     stutter, not a clean failure.
#   CPU pinning is NOT a Docker flag — MSAB pins its own workers in-process
#     (worker.manager.ts), and worker count is derived from nproc, not set here.
# NOTE: awslogs Docker log driver rejected awslogs-stream-prefix on Docker 29.x/Ubuntu 24.04.
# Using json-file with rotation instead. CloudWatch shipping is via the CW Agent above.
docker run -d \
  --name msab \
  --restart unless-stopped \
  --network host \
  --memory=${container_memory_mib}m \
  --memory-swap=${container_memory_mib}m \
  --log-driver=json-file \
  --log-opt max-size=100m \
  --log-opt max-file=5 \
  --env-file /opt/msab/.env \
  --env-file /opt/msab/.env.secrets \
  $ECR_REPO_URL:${image_tag}

# --- Wait for app health — the RELEASE GATE (aws-production 02) ---
# A container that can't reach /health inside the window exits here, with the
# launch hook still open: the EXIT trap tears the container down and ABANDONs
# the hook, so the ASG replaces the instance immediately — it never goes
# InService. The ceiling is RENDERED from var.container_warmup_seconds (ticket
# 17's measured docker-run→healthy budget), the same variable that feeds the
# ELB grace period and the launch-hook heartbeat derivation — never a
# free-standing literal, so the health ceiling and hook timing cannot drift.
echo "Waiting for /health endpoint..."
HEALTH_MAX_WAIT=${health_max_wait_seconds}
HEALTH_ELAPSED=0
HEALTH_OK=0

while [ $HEALTH_ELAPSED -lt $HEALTH_MAX_WAIT ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%%{http_code}" "http://localhost:${app_port}/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Health check passed (HTTP $HTTP_CODE)"
    HEALTH_OK=1
    break
  fi
  echo "  ⏳ Health check: HTTP $HTTP_CODE ($${HEALTH_ELAPSED}s/$${HEALTH_MAX_WAIT}s)"
  sleep 5
  HEALTH_ELAPSED=$((HEALTH_ELAPSED + 5))
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo "❌ FATAL: /health did not pass within $${HEALTH_MAX_WAIT}s — failing closed (container will be removed)."
  exit 1
fi

# --- Per-instance TLS termination (ticket 39 — AWS port of MSAB issue 36) ---
# nginx sidecar on :443 -> 127.0.0.1:${app_port}, WebSocket upgrade passthrough
# (Socket.IO/WSS is the whole workload — same shape as the Vultr terminator).
# Cert/key/chain are fetched from SSM SecureString above, NEVER rendered
# directly into this template (ticket 39 decision — see the ticket's
# "Implementation notes" for why SSM was chosen over the Vultr render pattern).
#
# FAILS OPEN, deliberately AFTER the health gate and the launch hook is still
# open at this point: a broken nginx config here must never abort the
# instance's release to the fleet, so this block never uses `exit 1` and
# every docker/nginx failure is swallowed with `|| true` / a log line. The
# NLB/:${app_port} path is completely unaffected either way — this is a pure
# addition, not a replacement.
if [ -n "$SECRET_TLS_CERT" ] && [ -n "$SECRET_TLS_KEY" ]; then
  echo "=== Configuring per-instance TLS terminator (nginx :443 -> 127.0.0.1:${app_port}) ==="
  TLS_DIR="$APP_DIR/tls"
  mkdir -p "$TLS_DIR"

  printf '%s\n%s\n' "$SECRET_TLS_CERT" "$SECRET_TLS_CHAIN" > "$TLS_DIR/fullchain.pem"
  printf '%s\n' "$SECRET_TLS_KEY" > "$TLS_DIR/privkey.pem"
  chmod 600 "$TLS_DIR/privkey.pem"
  chmod 644 "$TLS_DIR/fullchain.pem"

  cat > "$APP_DIR/nginx-tls.conf" << 'NGINXEOF'
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name _;

    ssl_certificate     /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:${app_port};
        proxy_http_version 1.1;

        # WebSocket upgrade (Socket.IO/WSS) — must pass through unchanged.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_connect_timeout 10s;
        proxy_read_timeout    3600s;
        proxy_send_timeout    3600s;
    }
}
NGINXEOF

  if docker run -d \
    --name msab-tls \
    --restart unless-stopped \
    --network host \
    --log-driver=json-file \
    --log-opt max-size=20m \
    --log-opt max-file=3 \
    -v "$TLS_DIR:/etc/nginx/tls:ro" \
    -v "$APP_DIR/nginx-tls.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:1.27-alpine >/dev/null; then
    echo "✅ Per-instance TLS terminator started (msab-tls container)."
  else
    echo "⚠️ Per-instance TLS terminator FAILED to start (non-fatal — :${app_port}/NLB path unaffected)."
  fi
else
  echo "Per-instance TLS terminator SKIPPED — tls-certificate/tls-private-key not set in SSM for this environment (fails OPEN)."
fi

%{ if manage_instance_dns ~}
# --- Per-instance DNS (ticket 39 — AWS port of MSAB issue 16) ---
# ASG instances have no static per-instance terraform resource to hang a DNS
# record off of (instance ids aren't known until launch) — unlike Vultr's
# `cloudflare_dns_record.instance` for_each over module.compute, this record
# is SELF-REGISTERED from user-data at boot. Rendered into the script at all
# ONLY when manage_instance_dns = true (this whole block disappears from the
# script otherwise — not merely skipped at runtime).
#
# Hostname = <ec2-instance-id>.${audio_domain} — reuses the SAME identity
# already fetched above as $INSTANCE_ID (also INSTANCE_ID_OVERRIDE), not a
# new one, at the same `*.audio.<domain>` label depth the Origin CA
# certificate's wildcard covers (mirrors issue 16's Vultr decision exactly).
#
# Non-fatal by construction, same reasoning as the TLS block: DNS
# registration must never gate the launch hook. The record and the
# terminator that answers it are independently fail-open — a DNS create
# failure just means this instance is unreachable by its pinned name until
# the next boot/replace, not that it drops out of the fleet.
echo "=== Registering per-instance DNS record ($INSTANCE_ID.${audio_domain}) ==="
CF_API_TOKEN=$(fetch_ssm "cloudflare-api-token")
if [ -n "$CF_API_TOKEN" ]; then
  DNS_HOSTNAME="$INSTANCE_ID.${audio_domain}"
  CF_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${cloudflare_zone_id}/dns_records" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"A\",\"name\":\"$DNS_HOSTNAME\",\"content\":\"$PUBLIC_IP\",\"proxied\":true,\"ttl\":1}" 2>/dev/null || echo '{"success":false}')
  if echo "$CF_RESPONSE" | grep -q '"success":true'; then
    echo "✅ DNS record created: $DNS_HOSTNAME -> $PUBLIC_IP"
    # Handed to the terminate-hook drain script below so it can delete the
    # SAME record on scale-in without a second Cloudflare lookup-by-name call.
    echo "$DNS_HOSTNAME" > /opt/msab/.dns-hostname
    printf '%s' "$CF_API_TOKEN" > /opt/msab/.cf-token
    chmod 600 /opt/msab/.dns-hostname /opt/msab/.cf-token
  else
    echo "⚠️ DNS record creation FAILED (non-fatal — instance still serves fine via the NLB/regional path): $CF_RESPONSE"
  fi
else
  echo "⚠️ cloudflare-api-token not set in SSM — per-instance DNS registration SKIPPED (non-fatal)."
fi
%{ endif ~}

# --- Complete the ASG launch lifecycle hook — THE LAST ACT (aws-production 02) ---
# Strictly after the health gate: CONTINUE is the release of this instance to the
# fleet, and everything a boot can get wrong has already been proven right above.
# A failure of this call itself also fails closed — the hook expires to its
# ABANDON default and the (healthy) instance is replaced; annoying, never an
# outage. The old ordering (complete before `docker run`) is the F4 defect this
# block exists to kill: do not move it earlier.
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
    echo "✅ Launch lifecycle hook completed — instance released to the fleet" || \
    echo "⚠️ Launch lifecycle hook completion failed — hook will expire to its ABANDON default and this instance will be replaced"
else
  echo "⚠️ Could not determine ASG name — hook will expire to its ABANDON default (standalone run?)"
fi

echo "=== MSAB ASG bootstrap complete ==="
echo "Health check: http://$PUBLIC_IP:${app_port}/health"
