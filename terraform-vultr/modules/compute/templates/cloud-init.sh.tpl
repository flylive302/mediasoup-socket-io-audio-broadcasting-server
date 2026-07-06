#!/bin/bash
# =============================================================================
# FlyLive Audio Server — Vultr Instance Bootstrap (cloud-init user_data)
# =============================================================================
# Runs once on first boot. Replaces the AWS ASG user-data.sh: installs Docker,
# pulls the pinned image from ghcr.io, renders the env file, runs the
# container. Rendered by Terraform's templatefile() — every substitution below
# is resolved at PLAN time, not fetched at boot.
#
# PUBLIC_IP is NOT fetched from an in-instance metadata call: it is the
# `vultr_reserved_ip` resource's `subnet` attribute, already known to
# Terraform before this script is ever rendered. This is the load-bearing
# contract from 04-single-region-vultr-tracer.md — see modules/compute's
# `public_ip` output precondition for the enforced guard.
# =============================================================================

set -euo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

echo "=== Starting MSAB Vultr bootstrap ==="
echo "Announced public IP (Terraform-known): ${announced_ip}"

# --- System updates ---
apt-get update -qq
apt-get upgrade -y -qq

# --- Disable ufw early: Vultr's cloud firewall is the single intended perimeter ---
# Ubuntu images may ship ufw active (only 22/tcp allowed), which would block the
# app port (${app_port}) and the WebRTC range under --network host. Guarded so it's
# a true no-op (won't trip `set -e`) on images where ufw isn't installed.
if command -v ufw >/dev/null 2>&1; then
  ufw --force disable || true
fi

# --- Install Docker ---
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# --- Kernel tuning for WebRTC ---
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

# --- File descriptor limits ---
cat >> /etc/security/limits.conf << 'EOF'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

# --- Disable conntrack for WebRTC UDP (massive perf win) ---
iptables -t raw -A PREROUTING -p udp --dport ${rtc_min_port}:${rtc_max_port} -j NOTRACK 2>/dev/null || true
iptables -t raw -A OUTPUT -p udp --sport ${rtc_min_port}:${rtc_max_port} -j NOTRACK 2>/dev/null || true

DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
netfilter-persistent save

# --- App directory ---
APP_DIR="/opt/msab"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# --- Fail fast on empty secrets (rendered at plan time; catches an empty tfvars value) ---
MISSING_SECRETS=0
for SECRET_CHECK in "JWT_SECRET:${jwt_secret}" "LARAVEL_INTERNAL_KEY:${laravel_internal_key}" "REDIS_PASSWORD:${redis_password}" "SESSION_SECRET:${session_secret}" "GHCR_PULL_TOKEN:${ghcr_pull_token}"; do
  CHECK_NAME="$${SECRET_CHECK%%:*}"
  CHECK_VALUE="$${SECRET_CHECK#*:}"
  if [ -z "$CHECK_VALUE" ]; then
    echo "FATAL: $CHECK_NAME is empty — check the tfvars secret was actually set."
    MISSING_SECRETS=1
  fi
done
if [ "$MISSING_SECRETS" -eq 1 ]; then
  echo "Bootstrap aborted: critical secrets missing."
  exit 1
fi

# --- Valkey TLS: Vultr's managed Valkey presents a PUBLICLY-rooted certificate
# (verified: it chains to a root already in Node's built-in trust store). Do NOT
# pass a custom CA — setting `ca:` makes Node REPLACE its default roots with only
# that cert, which can't complete the chain → "unable to get local issuer
# certificate" → every Redis command rejects → crash loop. So REDIS_TLS_CA_PATH is
# intentionally unset below; redis.ts then uses rejectUnauthorized:true with the
# built-in roots. (This differs from AWS ElastiCache, which uses a private CA.) ---

# --- Pull image from ghcr.io (read-only classic PAT, read:packages only) ---
echo "${ghcr_pull_token}" | docker login ghcr.io -u flylive302 --password-stdin
docker pull ${image_ref}

# --- Non-secret env file ---
cat > "$APP_DIR/.env" << ENVEOF
NODE_ENV=production
PORT=${app_port}
LOG_LEVEL=info

# Valkey (managed, TLS required — publicly-rooted cert, so no custom CA path;
# see the Valkey TLS note above for why REDIS_TLS_CA_PATH must stay unset)
REDIS_HOST=${redis_host}
REDIS_PORT=${redis_port}
REDIS_DB=3
REDIS_TLS=true

# JWT Authentication
JWT_MAX_AGE_SECONDS=${jwt_max_age_seconds}

# Laravel
LARAVEL_API_URL=${laravel_api_url}
LARAVEL_API_TIMEOUT_MS=${laravel_api_timeout_ms}

# MediaSoup
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=${announced_ip}
MEDIASOUP_RTC_MIN_PORT=${rtc_min_port}
MEDIASOUP_RTC_MAX_PORT=${rtc_max_port}
MEDIASOUP_NUM_WORKERS=${mediasoup_num_workers}

# Metrics — Vultr has no AWS CloudWatch, so the publisher only spams
# "Region is missing" / "Failed to publish CloudWatch metrics". Keep it off here.
CLOUDWATCH_ENABLED=false

# Security
CORS_ORIGINS=${cors_origins}

# ICE Servers (STUN/TURN for WebRTC NAT traversal)
ICE_STUN_URLS=${ice_stun_urls}
CLOUDFLARE_TURN_KEY_ID=${cloudflare_turn_key_id}

# SFU Cascade
CASCADE_ENABLED=${cascade_enabled}
CASCADE_THRESHOLD=1800
PUBLIC_IP=${announced_ip}

# realtime-09 broadcast HLS tier (non-sensitive; R2 keys passed via docker -e)
BROADCAST_HLS_ENABLED=${broadcast_hls_enabled}
HLS_R2_ENDPOINT=${hls_r2_endpoint}
HLS_R2_BUCKET=${hls_r2_bucket}
HLS_PUBLIC_BASE_URL=${hls_public_base_url}
ENVEOF
chmod 600 "$APP_DIR/.env"

# --- Run container ---
docker run -d \
  --name msab \
  --restart unless-stopped \
  --network host \
  --memory=3g \
  --memory-swap=3g \
  --log-driver=json-file \
  --log-opt max-size=100m \
  --log-opt max-file=5 \
  --env-file "$APP_DIR/.env" \
  -e "JWT_SECRET=${jwt_secret}" \
  -e "LARAVEL_INTERNAL_KEY=${laravel_internal_key}" \
  -e "INTERNAL_API_KEY=${laravel_internal_key}" \
  -e "SESSION_SECRET=${session_secret}" \
  -e "CLOUDFLARE_TURN_API_KEY=${cloudflare_turn_api_key}" \
  -e "REDIS_PASSWORD=${redis_password}" \
  -e "HLS_R2_ACCESS_KEY_ID=${hls_r2_access_key_id}" \
  -e "HLS_R2_SECRET_ACCESS_KEY=${hls_r2_secret_access_key}" \
  ${image_ref}

# --- Wait for /health ---
echo "Waiting for /health endpoint..."
HEALTH_MAX_WAIT=120
HEALTH_ELAPSED=0

while [ $HEALTH_ELAPSED -lt $HEALTH_MAX_WAIT ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%%{http_code}" "http://localhost:${app_port}/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "Health check passed (HTTP $HTTP_CODE)"
    break
  fi
  echo "  Health check: HTTP $HTTP_CODE ($${HEALTH_ELAPSED}s/$${HEALTH_MAX_WAIT}s)"
  sleep 5
  HEALTH_ELAPSED=$((HEALTH_ELAPSED + 5))
done

if [ $HEALTH_ELAPSED -ge $HEALTH_MAX_WAIT ]; then
  echo "WARNING: health check did not pass in $${HEALTH_MAX_WAIT}s — check 'docker logs msab'"
fi

echo "=== MSAB Vultr bootstrap complete ==="
echo "Health check: http://${announced_ip}:${app_port}/health"
