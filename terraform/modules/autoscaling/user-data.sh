#!/bin/bash
# =============================================================================
# FlyLive Audio Server — EC2 User Data (ASG Bootstrap Script)
# =============================================================================
# Runs on first boot to install Docker, clone repo, build, start the app,
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

# --- Install Docker Compose ---
apt-get install -y docker-compose-plugin

# --- Install Git ---
apt-get install -y git

# --- Install AWS CLI v2 (for lifecycle hook completion) ---
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

# --- Clone and Build ---
APP_DIR="/opt/msab"
mkdir -p "$APP_DIR"

git clone --depth 1 --branch ${github_branch} ${github_repo} "$APP_DIR"
cd "$APP_DIR"

# --- Create .env file ---
cat > .env << ENVEOF
NODE_ENV=production
PORT=${app_port}
LOG_LEVEL=info

# Redis
REDIS_HOST=${redis_host}
REDIS_PORT=${redis_port}
REDIS_PASSWORD=${redis_password}
REDIS_DB=3
REDIS_TLS=false

# JWT
JWT_SECRET=${jwt_secret}

# Laravel
LARAVEL_API_URL=${laravel_api_url}
LARAVEL_INTERNAL_KEY=${laravel_internal_key}

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
SESSION_SECRET=${session_secret}

# Laravel Events
MSAB_EVENTS_CHANNEL=flylive:msab:events
MSAB_EVENTS_ENABLED=true

# CloudWatch (enabled in production)
CLOUDWATCH_ENABLED=true

# AWS Region (for cross-region room routing)
AWS_REGION=${region}

# SFU Cascade (Phase 5)
CASCADE_ENABLED=${cascade_enabled}
CASCADE_THRESHOLD=1800
INTERNAL_API_KEY=${laravel_internal_key}
PUBLIC_IP=$PUBLIC_IP
ENVEOF

# --- Build Docker Image (use host network for DNS resolution in VPC) ---
docker build --network=host -t msab:latest -f docker/Dockerfile .

# --- Run Container ---
docker run -d \
  --name msab \
  --restart unless-stopped \
  --network host \
  --env-file .env \
  msab:latest

# --- Install Lifecycle Drain Service ---
# This script polls ASG lifecycle state and triggers drain mode before termination
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
