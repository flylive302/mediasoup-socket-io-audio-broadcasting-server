#!/bin/bash
# =============================================================================
# FlyLive Audio Server — Deploy to EC2 (SSH-based)
# =============================================================================
# Usage:
#   ./scripts/aws/deploy-ec2.sh               # deploy latest from current branch
#   ./scripts/aws/deploy-ec2.sh --branch main  # deploy specific branch
# =============================================================================

set -euo pipefail

# --- Configuration ---
EC2_IP="${EC2_IP:-$(cd terraform && terraform output -raw ec2_public_ip 2>/dev/null || echo "")}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_USER="ubuntu"
APP_DIR="/opt/msab"
BRANCH="${1:-}"

if [[ -z "$EC2_IP" ]]; then
  echo "❌ Cannot determine EC2 IP. Set EC2_IP env var or run terraform."
  exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "❌ SSH key not found: $SSH_KEY"
  exit 1
fi

SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_USER@$EC2_IP"

echo "🚀 Deploying to $EC2_IP..."

# --- Pull latest code ---
if [[ -n "$BRANCH" && "$BRANCH" == "--branch" ]]; then
  BRANCH="${2:-main}"
  echo "📦 Pulling branch: $BRANCH"
  $SSH_CMD "cd $APP_DIR && sudo git fetch origin && sudo git checkout $BRANCH && sudo git pull origin $BRANCH"
else
  echo "📦 Pulling latest code..."
  $SSH_CMD "cd $APP_DIR && sudo git pull"
fi

# --- Rebuild Docker image ---
echo "🔨 Building Docker image..."
$SSH_CMD "cd $APP_DIR && sudo docker build --network=host -t msab:latest -f docker/Dockerfile ."

# --- Restart container ---
echo "🔄 Restarting container..."
$SSH_CMD "sudo docker stop msab 2>/dev/null || true && sudo docker rm msab 2>/dev/null || true && cd $APP_DIR && sudo docker run -d --name msab --restart unless-stopped --network host --env-file .env msab:latest"

# --- Wait for health check ---
echo "⏳ Waiting for health check..."
sleep 5
HEALTH=$($SSH_CMD "curl -s -o /dev/null -w '%{http_code}' http://localhost:3030/health" 2>/dev/null || echo "000")

if [[ "$HEALTH" == "200" ]]; then
  echo "✅ Deploy complete! Health check: 200 OK"
else
  echo "⚠️  Health check returned: $HEALTH"
  echo "   Check logs: $SSH_CMD 'sudo docker logs msab --tail 50'"
fi

# --- Show container status ---
$SSH_CMD "sudo docker ps --filter name=msab --format 'table {{.Status}}\t{{.Ports}}'"
