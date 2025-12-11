#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Setup Infrastructure
# =============================================================================
# One-time setup script to create all Digital Ocean infrastructure:
# - VPC Network
# - Managed Valkey Cluster (Redis-compatible)
# - Load Balancer with Sticky Sessions
# - Firewall with UDP rules
# - First audio server droplet
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Main Setup
# -----------------------------------------------------------------------------

main() {
    echo ""
    echo "=============================================="
    echo "  FlyLive Audio Server - Infrastructure Setup"
    echo "=============================================="
    echo ""
    local lb_ip=$(doctl compute load-balancer list --format IP,Name --no-header | grep "^[0-9.]* ${LB_NAME}$" | awk '{print $1}')
    if [[ -z "$lb_ip" ]]; then
        log_warn "Load balancer IP not yet assigned (pending)"
        lb_ip="<pending>"
    fi

    check_doctl
    check_required_vars
    
    log_info "Starting infrastructure setup in region: ${DO_REGION}"
    echo ""
    
    # Step 1: Create VPC
    create_vpc
    
    # Step 2: Create Managed Valkey
    create_valkey
    
    # Step 3: Create Firewall
    create_firewall
    
    # Step 4: Create First Droplet
    create_first_droplet
    
    # Step 5: Deploy to First Droplet
    deploy_to_droplet
    
    # Step 6: Create Load Balancer
    create_load_balancer
    
    # Step 7 (Post-Setup): Print Summary
    print_summary
}
# -----------------------------------------------------------------------------
# Step 1: Create VPC
# -----------------------------------------------------------------------------

create_vpc() {
    log_info "Step 1/6: Creating VPC..."
    
    local existing_vpc=$(get_vpc_id)
    
    if [[ -n "$existing_vpc" ]]; then
        log_warn "VPC '${VPC_NAME}' already exists (ID: ${existing_vpc})"
        export VPC_ID="$existing_vpc"
        return 0
    fi
    
    VPC_ID=$(doctl vpcs create \
        --name "${VPC_NAME}" \
        --region "${DO_REGION}" \
        --ip-range "10.10.10.0/24" \
        --format ID \
        --no-header)
    
    export VPC_ID
    log_success "Created VPC: ${VPC_ID}"
}

# -----------------------------------------------------------------------------
# Step 2: Create Managed Valkey (Redis-compatible)
# -----------------------------------------------------------------------------

create_valkey() {
    log_info "Step 2/6: Creating Managed Valkey cluster..."
    
    local existing_valkey=$(doctl databases list --format Name --no-header 2>/dev/null | grep "^${VALKEY_NAME}$" || echo "")
    
    if [[ -n "$existing_valkey" ]]; then
        log_warn "Valkey cluster '${VALKEY_NAME}' already exists"
        return 0
    fi
    
    # Note: DO uses 'valkey' as engine type for Managed Caching for Valkey
    doctl databases create "${VALKEY_NAME}" \
        --engine valkey \
        --version "${VALKEY_VERSION}" \
        --region "${DO_REGION}" \
        --size "${VALKEY_SIZE}" \
        --num-nodes 1 \
        --private-network-uuid "${VPC_ID}"
    
    log_info "Waiting for Valkey to be ready (this takes 3-5 minutes)..."
    
    local max_wait=300
    local waited=0
    
    while [[ $waited -lt $max_wait ]]; do
        local status=$(doctl databases get "${VALKEY_NAME}" --format Status --no-header 2>/dev/null || echo "")
        if [[ "$status" == "online" ]]; then
            log_success "Valkey cluster is online"
            return 0
        fi
        sleep 10
        waited=$((waited + 10))
        echo -n "."
    done
    
    echo ""
    log_error "Timeout waiting for Valkey cluster"
    exit 1
}

# -----------------------------------------------------------------------------
# Step 3: Create Firewall
# -----------------------------------------------------------------------------

create_firewall() {
    log_info "Step 3/6: Creating Firewall..."
    
    local existing_fw=$(get_firewall_id)
    
    if [[ -n "$existing_fw" ]]; then
        log_warn "Firewall '${FIREWALL_NAME}' already exists (ID: ${existing_fw})"
        return 0
    fi
    
    doctl compute firewall create \
        --name "${FIREWALL_NAME}" \
        --tag-names "${PROJECT_NAME}" \
        --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:${SERVER_PORT},address:0.0.0.0/0,address:::/0 protocol:udp,ports:${RTC_MIN_PORT}-${RTC_MAX_PORT},address:0.0.0.0/0,address:::/0 protocol:tcp,ports:${RTC_MIN_PORT}-${RTC_MAX_PORT},address:0.0.0.0/0,address:::/0" \
        --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
    
    log_success "Firewall created with UDP ports ${RTC_MIN_PORT}-${RTC_MAX_PORT}"
}

# -----------------------------------------------------------------------------
# Step 4: Create First Droplet
# -----------------------------------------------------------------------------
create_first_droplet() {
    log_info "Step 4/6: Creating first droplet..."
    
    if [[ -z "${VPC_ID:-}" ]]; then
        VPC_ID=$(get_vpc_id)
    fi
    
    if [[ -z "${DO_SSH_KEY_FINGERPRINT}" ]]; then
        log_error "DO_SSH_KEY_FINGERPRINT is required"
        log_info "Get your SSH key fingerprint with: doctl compute ssh-key list"
        exit 1
    fi
    
    if [[ -z "${DO_SSH_PRIVATE_KEY}" ]]; then
        log_error "DO_SSH_PRIVATE_KEY is required"
        log_info "Set DO_SSH_PRIVATE_KEY to the path of your SSH private key file"
        log_info "Example: DO_SSH_PRIVATE_KEY=~/.ssh/id_ed25519"
        exit 1
    fi
    
    # Validate private key file exists and is readable
    local expanded_key_path="${DO_SSH_PRIVATE_KEY/#\~/$HOME}"
    if [[ ! -f "$expanded_key_path" ]]; then
        log_error "SSH private key file not found: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    
    if [[ ! -r "$expanded_key_path" ]]; then
        log_error "SSH private key file is not readable: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi    fi
    
    DROPLET_NAME="${PROJECT_NAME}-01"
    
    # Check if already exists
    local existing=$(doctl compute droplet list --format Name --no-header | grep "^${DROPLET_NAME}$" || echo "")
    if [[ -n "$existing" ]]; then
        log_warn "Droplet '${DROPLET_NAME}' already exists"
        DROPLET_IP=$(get_droplet_ip "${DROPLET_NAME}")
        return 0
    fi
    
    DROPLET_ID=$(doctl compute droplet create "${DROPLET_NAME}" \
        --size "${DO_DROPLET_SIZE}" \
        --image "${DO_IMAGE}" \
        --region "${DO_REGION}" \
        --vpc-uuid "${VPC_ID}" \
        --ssh-keys "${DO_SSH_KEY_FINGERPRINT}" \
        --tag-name "${PROJECT_NAME}" \
        --enable-monitoring \
        --format ID \
        --no-header \
        --wait)
    
    DROPLET_IP=$(get_droplet_ip "${DROPLET_NAME}")
    
    log_success "Droplet created: ${DROPLET_NAME} (${DROPLET_IP})"
    
    local valkey_info=$(doctl databases connection "${VALKEY_NAME}" --format Host,Port,User,Password --no-header 2>/dev/null)
    if [[ -z "$valkey_info" ]]; then
        log_error "Failed to retrieve Valkey connection info"
        exit 1
    fi
    local valkey_host=$(echo "$valkey_info" | awk '{print $1}')
    local valkey_port=$(echo "$valkey_info" | awk '{print $2}')
    local valkey_user=$(echo "$valkey_info" | awk '{print $3}')
    local valkey_password=$(echo "$valkey_info" | awk '{print $4}')
    if [[ -z "$valkey_host" || -z "$valkey_port" || -z "$valkey_user" || -z "$valkey_password" ]]; then
        log_error "Incomplete Valkey connection info: host=$valkey_host port=$valkey_port user=$valkey_user"
        exit 1
    fi
    
# -----------------------------------------------------------------------------
# Step 5: Deploy to First Droplet
# -----------------------------------------------------------------------------

deploy_to_droplet() {
    log_info "Step 5/6: Deploying audio server to droplet..."
    
    if [[ -z "${DROPLET_IP:-}" ]]; then
        DROPLET_IP=$(get_droplet_ip "${PROJECT_NAME}-01")
    fi
    
    # Get Valkey connection info (Redis-compatible)
    # Username is typically 'default' for DO Managed Valkey
    local valkey_info=$(doctl databases connection "${VALKEY_NAME}" --format Host,Port,User,Password --no-header)
    local valkey_host=$(echo "$valkey_info" | awk '{print $1}')
    local valkey_port=$(echo "$valkey_info" | awk '{print $2}')
    local valkey_user=$(echo "$valkey_info" | awk '{print $3}')
    local valkey_password=$(echo "$valkey_info" | awk '{print $4}')
    
    log_info "Connecting to ${DROPLET_IP}..."
    
    # Secure SSH connection with host key verification
    # Use a dedicated known_hosts file to track droplet host keys
    # accept-new: allows first-time connections but prevents MITM on subsequent connections
    local known_hosts_file="${SCRIPT_DIR}/.known_hosts"
    mkdir -p "$(dirname "${known_hosts_file}")"
    
    # Deploy via SSH with secure host key checking
    ssh -i "${DO_SSH_PRIVATE_KEY}" \
        -o UserKnownHostsFile="${known_hosts_file}" \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=30 \
        "root@${DROPLET_IP}" << REMOTE_SCRIPT        

set -e

echo "Cloning repository..."
if [[ -d /opt/audio-server ]]; then
    cd /opt/audio-server
    git fetch origin
    git reset --hard origin/${GITHUB_BRANCH}
else
    git clone --branch ${GITHUB_BRANCH} ${GITHUB_REPO} /opt/audio-server
    cd /opt/audio-server
fi

# Set variables for environment file generation (expanded from local script)
valkey_host="${valkey_host}"
valkey_port="${valkey_port}"
valkey_user="${valkey_user}"
valkey_password="${valkey_password}"
droplet_ip="${DROPLET_IP}"

echo "Creating environment file..."
# Inner here-doc is unquoted so variables are expanded on the remote
cat > .env << ENV_EOF
NODE_ENV=production
PORT=${SERVER_PORT}
LOG_LEVEL=info

REDIS_HOST=\${valkey_host}
REDIS_PORT=\${valkey_port}
REDIS_USERNAME=\${valkey_user}
REDIS_PASSWORD=\${valkey_password}
REDIS_TLS=true
REDIS_DB=${VALKEY_DB}

LARAVEL_API_URL=${LARAVEL_API_URL}
LARAVEL_INTERNAL_KEY=${LARAVEL_INTERNAL_KEY}

MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=\${droplet_ip}
MEDIASOUP_RTC_MIN_PORT=${RTC_MIN_PORT}
MEDIASOUP_RTC_MAX_PORT=${RTC_MAX_PORT}

CORS_ORIGINS=${CORS_ORIGINS}
ENV_EOF

echo "Building Docker image..."
docker build -t ${DOCKER_IMAGE} -f docker/Dockerfile .

echo "Stopping existing container (if any)..."
docker stop ${CONTAINER_NAME} 2>/dev/null || true
docker rm ${CONTAINER_NAME} 2>/dev/null || true

echo "Starting container..."
docker run -d \\
    --name ${CONTAINER_NAME} \\
    --restart unless-stopped \\
    --network host \\
    --env-file .env \\
    ${DOCKER_IMAGE}

echo "Deployment complete!"
REMOTE_SCRIPT

    log_success "Deployed to ${DROPLET_IP}"
    
    # Wait for health check
    check_health "${DROPLET_IP}"
}

# -----------------------------------------------------------------------------
# Step 6: Create Load Balancer
# -----------------------------------------------------------------------------

create_load_balancer() {
    log_info "Step 6/6: Creating Load Balancer..."
    
    local existing_lb=$(get_lb_id)
    
    if [[ -n "$existing_lb" ]]; then
        log_warn "Load Balancer '${LB_NAME}' already exists (ID: ${existing_lb})"
        return 0
    fi
    
    # Get droplet ID
    local droplet_id=$(doctl compute droplet list --format ID,Name --no-header | grep "${PROJECT_NAME}-01" | awk '{print $1}')
    
    if [[ -z "${VPC_ID:-}" ]]; then
        VPC_ID=$(get_vpc_id)
    fi
    
    # Create with HTTP only first (HTTPS requires cert)
    doctl compute load-balancer create \
        --name "${LB_NAME}" \
        --region "${DO_REGION}" \
        --vpc-uuid "${VPC_ID}" \
        --forwarding-rules "entry_protocol:http,entry_port:80,target_protocol:http,target_port:${SERVER_PORT}" \
        --health-check "protocol:http,port:${SERVER_PORT},path:/health,check_interval_seconds:10,response_timeout_seconds:5,healthy_threshold:2,unhealthy_threshold:3" \
        --sticky-sessions "type:cookies,cookie_name:AUDIO_SERVER_SESSION,cookie_ttl_seconds:3600" \
        --droplet-ids "${droplet_id}"
    
    log_success "Load Balancer created (HTTP only for now)"
    log_info "Run './setup-ssl.sh' next to enable HTTPS!"
}

# -----------------------------------------------------------------------------
# Print Summary
# -----------------------------------------------------------------------------

print_summary() {
    echo ""
    echo "=============================================="
    echo "  Infrastructure Setup Complete!"
    echo "=============================================="
    echo ""
    
    # Get load balancer IP
    local lb_ip=$(doctl compute load-balancer list --format IP,Name --no-header | grep "${LB_NAME}" | awk '{print $1}')
    
    log_info "Resources created:"
    echo "  - VPC: ${VPC_NAME}"
    echo "  - Valkey: ${VALKEY_NAME}"
    echo "  - Firewall: ${FIREWALL_NAME}"
    echo "  - Droplet: ${PROJECT_NAME}-01 (${DROPLET_IP:-unknown})"
    echo "  - Load Balancer: ${LB_NAME} (${lb_ip:-pending...})"
    echo ""
    
    log_warn "NEXT STEPS:"
    echo ""
    echo "  1. Configure DNS:"
    echo "     - Add A record: ${AUDIO_DOMAIN} -> ${lb_ip:-<load_balancer_ip>}"
    echo ""
    echo "  2. Enable SSL (HTTPS):"
    echo "     - Run: ./setup-ssl.sh"
    echo "     (This will generate a certificate and update the Load Balancer)"
    echo ""
    echo "  3. Test the health endpoint:"
    echo "     curl http://${lb_ip:-<load_balancer_ip>}/health"
    echo ""
}

# Run main
main "$@"
