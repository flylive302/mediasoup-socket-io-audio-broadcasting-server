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
        printf "export JWT_SECRET=%q\n" "${JWT_SECRET}"
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

JWT_SECRET=${JWT_SECRET}
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
CONTAINER_ID=$(docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --network host \
    --env-file .env \
    "${DOCKER_IMAGE}")

# #region agent log
echo "DEBUG: Container ID: ${CONTAINER_ID}"
# #endregion

# Wait a moment for container to initialize
sleep 5

# Check container status
CONTAINER_STATUS=$(docker inspect --format='{{.State.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "not_found")
# #region agent log
echo "DEBUG: Container status after start: ${CONTAINER_STATUS}"
# #endregion

# Check if container is running
if [[ "${CONTAINER_STATUS}" != "running" ]]; then
    echo "ERROR: Container is not running (status: ${CONTAINER_STATUS})"
    echo "Container logs:"
    docker logs --tail 50 "${CONTAINER_NAME}" 2>&1 || echo "Could not retrieve logs"
    exit 1
fi

# Check container logs for errors
echo "Checking container logs for startup errors..."
CONTAINER_LOGS=$(docker logs --tail 100 "${CONTAINER_NAME}" 2>&1 || echo "")
# #region agent log
echo "DEBUG: Container logs (last 100 lines):"
echo "${CONTAINER_LOGS}"
# #endregion

# Check for common error patterns
if echo "${CONTAINER_LOGS}" | grep -qiE "(error|failed|exception|crash|exit code [^0])"; then
    echo "WARNING: Found error patterns in container logs"
fi

# Check and disable ufw if it's blocking connections (ufw interferes with Docker host networking)
echo "Checking local firewall (ufw)..."
if command -v ufw >/dev/null 2>&1; then
    UFW_STATUS=$(ufw status 2>&1 | head -1 || echo "inactive")
    # #region agent log
    echo "DEBUG: ufw status: ${UFW_STATUS}"
    # #endregion
    if echo "$UFW_STATUS" | grep -qi "active"; then
        echo "WARNING: ufw is active and may block Docker host networking. Disabling ufw..."
        ufw --force disable
        echo "ufw disabled"
    else
        echo "ufw is not active (good for Docker host networking)"
    fi
else
    echo "ufw not installed (using DigitalOcean cloud firewall)"
fi

echo "=== Deployment complete! ==="
REMOTE_SCRIPT

    log_success "Deployed to ${DROPLET_IP}"
    
    # Verify firewall is attached to droplet
    log_info "Verifying firewall is attached to droplet..."
    local droplet_id
    if [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        # If target is IP, find droplet ID by IP
        droplet_id=$(doctl compute droplet list --format ID,PublicIPv4 --no-header | grep -F "$target" | awk '{print $1}' | head -1)
    else
        # If target is name, get ID by name
        droplet_id=$(doctl compute droplet list --format ID,Name --no-header | grep -F "$target" | awk '{print $1}' | head -1)
    fi
    
    if [[ -n "$droplet_id" ]]; then
        local fw_id=$(get_firewall_id 2>/dev/null || echo "")
        # #region agent log
        local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
        local fw_timestamp=$(date +%s)000
        echo "{\"id\":\"log_${fw_timestamp}_firewall_check\",\"timestamp\":${fw_timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Firewall check\",\"data\":{\"droplet_id\":\"${droplet_id}\",\"firewall_id\":\"${fw_id:-none}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"E\"}" >> "${log_file}" 2>/dev/null || true
        # #endregion
        
        if [[ -n "$fw_id" ]]; then
            # Check if firewall is attached to this droplet (via tags or direct attachment)
            local fw_droplets=$(doctl compute firewall get "$fw_id" --format DropletIDs --no-header 2>/dev/null || echo "")
            local fw_tags=$(doctl compute firewall get "$fw_id" --format Tags --no-header 2>/dev/null || echo "")
            
            # #region agent log
            local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
            local fw_detail_timestamp=$(date +%s)000
            echo "{\"id\":\"log_${fw_detail_timestamp}_firewall_details\",\"timestamp\":${fw_detail_timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Firewall details\",\"data\":{\"firewall_id\":\"${fw_id}\",\"attached_droplets\":\"${fw_droplets}\",\"tags\":\"${fw_tags}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"E\"}" >> "${log_file}" 2>/dev/null || true
            # #endregion
            
            if echo "$fw_droplets" | grep -q "$droplet_id"; then
                log_success "Firewall is directly attached to droplet"
            elif echo "$fw_tags" | grep -q "${PROJECT_NAME}"; then
                log_info "Firewall is attached via tag '${PROJECT_NAME}' (should apply to droplet)"
            else
                log_warn "Firewall exists but may not be attached to droplet. Attaching now..."
                doctl compute firewall add-droplets "$fw_id" --droplet-ids "$droplet_id" 2>/dev/null || log_warn "Failed to attach firewall (may already be attached via tags)"
            fi
            
            # Check firewall rules
            local fw_rules=$(doctl compute firewall get "$fw_id" --format InboundRules --no-header 2>/dev/null || echo "")
            # #region agent log
            local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
            local fw_rules_timestamp=$(date +%s)000
            echo "{\"id\":\"log_${fw_rules_timestamp}_firewall_rules\",\"timestamp\":${fw_rules_timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Firewall inbound rules\",\"data\":{\"firewall_id\":\"${fw_id}\",\"rules\":\"${fw_rules:0:500}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"E\"}" >> "${log_file}" 2>/dev/null || true
            # #endregion
        else
            log_warn "Firewall '${FIREWALL_NAME}' not found. Port ${SERVER_PORT} may be blocked."
        fi
        
        # Test connectivity from inside the droplet
        log_info "Testing health endpoint from inside droplet..."
        local internal_test=$(ssh -i "${ssh_key_path}" \
            -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=10 \
            "root@${DROPLET_IP}" \
            "curl -sf --max-time 5 --connect-timeout 3 http://localhost:${SERVER_PORT}/health 2>&1 || echo 'INTERNAL_TEST_FAILED:$?'" 2>&1)
        
        # #region agent log
        local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
        local internal_test_timestamp=$(date +%s)000
        local internal_test_safe=$(echo "${internal_test}" | sed 's/"/\\"/g' | head -c 500)
        echo "{\"id\":\"log_${internal_test_timestamp}_internal_health_test\",\"timestamp\":${internal_test_timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Internal health test from droplet\",\"data\":{\"droplet_ip\":\"${DROPLET_IP}\",\"result\":\"${internal_test_safe}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"F\"}" >> "${log_file}" 2>/dev/null || true
        # #endregion
        
        if echo "$internal_test" | grep -q "INTERNAL_TEST_FAILED"; then
            log_error "Internal health check from droplet failed"
        else
            log_success "Internal health check from droplet works"
        fi
    fi
    
    # #region agent log
    local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
    local timestamp=$(date +%s)000
    echo "{\"id\":\"log_${timestamp}_deploy_complete\",\"timestamp\":${timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Deployment script completed\",\"data\":{\"droplet_ip\":\"${DROPLET_IP}\",\"droplet_id\":\"${droplet_id:-unknown}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"B\"}" >> "${log_file}" 2>/dev/null || true
    
    # Check container status via SSH before health check
    log_info "Checking container status on ${DROPLET_IP}..."
    local container_check=$(ssh -i "${ssh_key_path}" \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=10 \
        "root@${DROPLET_IP}" \
        "docker ps --filter name=${CONTAINER_NAME} --format '{{.Status}}' && docker inspect --format='{{.State.Status}}:{{.State.ExitCode}}:{{.State.Error}}' ${CONTAINER_NAME} 2>/dev/null || echo 'container_not_found'" 2>&1)
    
    local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
    local check_timestamp=$(date +%s)000
    local container_check_safe=$(echo "${container_check}" | sed 's/"/\\"/g' | head -c 1000)
    echo "{\"id\":\"log_${check_timestamp}_container_check\",\"timestamp\":${check_timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Container status check\",\"data\":{\"droplet_ip\":\"${DROPLET_IP}\",\"container_status\":\"${container_check_safe}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"C\"}" >> "${log_file}" 2>/dev/null || true
    log_info "Container status: ${container_check}"
    
    # Get recent container logs via SSH
    log_info "Fetching recent container logs..."
    local container_logs=$(ssh -i "${ssh_key_path}" \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=10 \
        "root@${DROPLET_IP}" \
        "docker logs --tail 50 ${CONTAINER_NAME} 2>&1 | head -100" 2>&1)
    
    local log_file="${PROJECT_ROOT:-${SCRIPT_DIR}/../..}/.cursor/debug.log"
    local logs_timestamp=$(date +%s)000
    local container_logs_safe=$(echo "${container_logs}" | sed 's/"/\\"/g' | head -c 2000)
    echo "{\"id\":\"log_${logs_timestamp}_container_logs\",\"timestamp\":${logs_timestamp},\"location\":\"deploy-droplet.sh:main\",\"message\":\"Container logs\",\"data\":{\"droplet_ip\":\"${DROPLET_IP}\",\"logs\":\"${container_logs_safe}\"},\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"D\"}" >> "${log_file}" 2>/dev/null || true
    # #endregion
    
    # Wait a moment for firewall rules to propagate and server to be fully ready
    log_info "Waiting 5 seconds for firewall rules to propagate..."
    sleep 5
    
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
