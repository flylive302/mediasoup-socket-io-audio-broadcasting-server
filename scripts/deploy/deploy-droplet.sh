#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Deploy to Droplet
# =============================================================================
# Deploys the audio server to a specific droplet IP or name.
# 
# Usage:
#   ./deploy-droplet.sh <droplet-ip-or-name> [commit-sha]
#   ./deploy-droplet.sh 167.99.123.45
#   ./deploy-droplet.sh flylive-audio-01
#   ./deploy-droplet.sh flylive-audio-01 a1b2c3d
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    local target="$1"
    local commit_sha="${2:-}"
    
    check_doctl
    
    # Expand potential tilde in SSH key path and validate
    local ssh_key_path="${DO_SSH_PRIVATE_KEY/#\~/$HOME}"
    if [[ ! -f "$ssh_key_path" ]]; then
        log_error "SSH private key not found at: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    if [[ ! -r "$ssh_key_path" ]]; then
        log_error "SSH private key is not readable: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    
    # Determine if target is IP or name
    if [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        DROPLET_IP="$target"
        log_info "Deploying to IP: ${DROPLET_IP}"
    else
        DROPLET_IP=$(get_droplet_ip "$target")
        if [[ -z "$DROPLET_IP" ]]; then
            log_error "Could not find droplet: $target"
            exit 1
        fi
        log_info "Deploying to ${target} (${DROPLET_IP})"
    fi
    
    # Get Valkey connection info (Redis-compatible)
    # Username is typically 'default' for DO Managed Valkey
    local valkey_info=$(get_valkey_info)
    if [[ -z "$valkey_info" ]]; then
        log_error "Could not get Valkey connection info. Is Valkey cluster '${VALKEY_NAME}' running?"
        exit 1
    fi
    
    local valkey_host=$(echo "$valkey_info" | awk '{print $1}')
    local valkey_port=$(echo "$valkey_info" | awk '{print $2}')
    local valkey_user=$(echo "$valkey_info" | awk '{print $3}')
    local valkey_password=$(echo "$valkey_info" | awk '{print $4}')
    
    log_info "Connecting to ${DROPLET_IP}..."
    if [[ -n "${commit_sha}" ]]; then
        log_info "Target commit: ${commit_sha}"
    else
        log_info "Target commit: HEAD of ${GITHUB_BRANCH}"
    fi

    # Create temporary environment file with sensitive variables
    # This avoids exposing secrets in process listings (ps) and command line
    local temp_env_file=$(mktemp)
    local remote_env_file="/tmp/deploy-env-$$.sh"
    
    # Write all deployment variables to temp file with proper escaping using printf %q
    # This ensures all special characters, spaces, and quotes are properly escaped
    {
        echo "#!/bin/bash"
        echo "# Temporary deployment environment file"
        echo "# This file contains sensitive credentials and will be cleaned up after deployment"
        echo ""
        printf "export GITHUB_REPO=%q\n" "${GITHUB_REPO}"
        printf "export GITHUB_BRANCH=%q\n" "${GITHUB_BRANCH}"
        printf "export COMMIT_SHA=%q\n" "${commit_sha}"
        printf "export SERVER_PORT=%q\n" "${SERVER_PORT}"
        printf "export DOCKER_IMAGE=%q\n" "${DOCKER_IMAGE}"
        printf "export CONTAINER_NAME=%q\n" "${CONTAINER_NAME}"
        printf "export REDIS_HOST=%q\n" "${valkey_host}"
        printf "export REDIS_PORT=%q\n" "${valkey_port}"
        printf "export REDIS_USERNAME=%q\n" "${valkey_user}"
        printf "export REDIS_PASSWORD=%q\n" "${valkey_password}"
        printf "export REDIS_DB=%q\n" "${VALKEY_DB}"
        printf "export LARAVEL_API_URL=%q\n" "${LARAVEL_API_URL}"
        printf "export LARAVEL_INTERNAL_KEY=%q\n" "${LARAVEL_INTERNAL_KEY}"
        printf "export MEDIASOUP_LISTEN_IP=%q\n" "0.0.0.0"
        printf "export MEDIASOUP_ANNOUNCED_IP=%q\n" "${DROPLET_IP}"
        printf "export RTC_MIN_PORT=%q\n" "${RTC_MIN_PORT}"
        printf "export RTC_MAX_PORT=%q\n" "${RTC_MAX_PORT}"
        printf "export CORS_ORIGINS=%q\n" "${CORS_ORIGINS}"
    } > "${temp_env_file}"

    # Securely copy environment file to remote host
    log_info "Transferring deployment configuration..."
    scp -i "${ssh_key_path}" \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=30 \
        "${temp_env_file}" "root@${DROPLET_IP}:${remote_env_file}" || {
        rm -f "${temp_env_file}"
        log_error "Failed to transfer deployment configuration"
        exit 1
    }
    
    # Clean up local temp file immediately after transfer
    rm -f "${temp_env_file}"
    
    # Deploy via SSH - source the env file on remote host
    # Use a trap to ensure cleanup of the remote env file even on failure
    ssh -i "${ssh_key_path}" \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=30 \
        "root@${DROPLET_IP}" \
        "trap 'rm -f \"${remote_env_file}\"' EXIT; source \"${remote_env_file}\" && bash -s" << 'REMOTE_SCRIPT'
set -e

echo "=== Deploying Audio Server ==="

# Clone or update repository
if [[ -d /opt/audio-server ]]; then
    echo "Updating existing repository..."
    cd /opt/audio-server
    git fetch origin
else
    echo "Cloning repository..."
    git clone "${GITHUB_REPO}" /opt/audio-server
    cd /opt/audio-server
    git fetch origin
fi

# Checkout specific commit or branch
if [[ -n "${COMMIT_SHA}" ]]; then
    echo "Checking out commit: ${COMMIT_SHA}"
    git checkout -f "${COMMIT_SHA}"
else
    echo "Checking out branch: ${GITHUB_BRANCH}"
    git checkout -f "origin/${GITHUB_BRANCH}"
fi

# Create environment file
echo "Creating environment file..."
cat > .env << ENV_EOF
NODE_ENV=production
PORT=${SERVER_PORT}
LOG_LEVEL=info

REDIS_HOST=${REDIS_HOST}
REDIS_PORT=${REDIS_PORT}
REDIS_USERNAME=${REDIS_USERNAME}
REDIS_PASSWORD=${REDIS_PASSWORD}
REDIS_TLS=true
REDIS_DB=${REDIS_DB}

LARAVEL_API_URL=${LARAVEL_API_URL}
LARAVEL_INTERNAL_KEY=${LARAVEL_INTERNAL_KEY}

MEDIASOUP_LISTEN_IP=${MEDIASOUP_LISTEN_IP}
MEDIASOUP_ANNOUNCED_IP=${MEDIASOUP_ANNOUNCED_IP}
MEDIASOUP_RTC_MIN_PORT=${RTC_MIN_PORT}
MEDIASOUP_RTC_MAX_PORT=${RTC_MAX_PORT}

CORS_ORIGINS=${CORS_ORIGINS}
ENV_EOF

# Generate version.json for health check
echo "Generating version info..."
# Get commit message (first line only)
COMMIT_MSG=$(git log -1 --pretty=%B | head -n 1)
# Create JSON file
cat > src/version.json << VERSION_EOF
{
  "commit": "${COMMIT_SHA:-$(git rev-parse HEAD)}",
  "branch": "${GITHUB_BRANCH}",
  "message": "$(echo "$COMMIT_MSG" | sed 's/"/\\"/g')", 
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
VERSION_EOF

# Build Docker image
echo "Building Docker image..."
# Use --cache-from if available (not implemented here but good for future)
docker build -t "${DOCKER_IMAGE}" -f docker/Dockerfile .

# Stop existing container (if any)
echo "Stopping existing container..."
docker stop "${CONTAINER_NAME}" 2>/dev/null || true
docker rm "${CONTAINER_NAME}" 2>/dev/null || true

# Start new container
echo "Starting container with host networking..."
docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --network host \
    --env-file .env \
    "${DOCKER_IMAGE}"

echo "=== Deployment complete! ==="
REMOTE_SCRIPT

    log_success "Deployed to ${DROPLET_IP}"
    
    # Verify health
    check_health "${DROPLET_IP}"
}

# Show usage if no argument
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <droplet-ip-or-name> [commit-sha]"
    echo ""
    echo "Examples:"
    echo "  $0 167.99.123.45"
    echo "  $0 flylive-audio-01"
    echo "  $0 flylive-audio-01 a1b2c3d"
    exit 1
fi

main "$1" "${2:-}"
