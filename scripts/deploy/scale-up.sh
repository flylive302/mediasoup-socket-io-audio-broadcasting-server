
#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Scale Up
# =============================================================================
# Add new droplets to the cluster and deploy audio server to them.
# 
# Usage:
#   ./scale-up.sh [count] [commit-sha]
#   ./scale-up.sh        # Adds 1 droplet (HEAD)
#   ./scale-up.sh 3      # Adds 3 droplets (HEAD)
#   ./scale-up.sh 2 a1b2c3d # Adds 2 droplets with specific commit
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

# Validate IPv4 address format
is_valid_ipv4() {
    local ip="$1"
    # Check if non-empty
    [[ -z "$ip" ]] && return 1
    # Basic IPv4 regex: 4 octets, each 0-255
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        # Validate each octet is 0-255
        IFS='.' read -ra ADDR <<< "$ip"
        for octet in "${ADDR[@]}"; do
            if [[ 10#$octet -lt 0 || 10#$octet -gt 255 ]]; then
                return 1
            fi
        done
        return 0
    fi
    return 1
}
# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    local count="${1:-1}"
    local commit_sha="${2:-}"
    
    check_doctl
    check_required_vars

    # Validate count is a positive integer
    if ! [[ "$count" =~ ^[0-9]+$ ]] || [[ "$count" -le 0 ]]; then
        log_error "Count must be a positive integer (got: '${count}')"
        echo "Usage: $0 [count] [commit-sha]"
        exit 1
    fi
    
    log_info "Scaling up: Adding ${count} new droplet(s)..."
    if [[ -n "${commit_sha}" ]]; then
        log_info "Target commit: ${commit_sha}"
    else
        log_info "Target commit: HEAD of ${GITHUB_BRANCH} (will resolve during deployment)"
    fi
    
    # Get VPC ID
    local vpc_id=$(get_vpc_id)
    if [[ -z "$vpc_id" ]]; then
        log_error "VPC '${VPC_NAME}' not found. Run setup-infrastructure.sh first."
        exit 1
    fi
    
    # Get Load Balancer ID
    local lb_id=$(get_lb_id)
    if [[ -z "$lb_id" ]]; then
        log_error "Load Balancer '${LB_NAME}' not found. Run setup-infrastructure.sh first."
        exit 1
    fi
    
    local new_droplet_names=()
    local new_droplet_ids=()
    local new_droplet_ips=()
    
    # Needs a loop to generate names because they must be unique
    # We can't just say "create N" if we want nice names like audio-01, audio-02
    
    log_info "Generating unique names..."
    for ((i=1; i<=count; i++)); do
        local name=$(generate_droplet_name)
        new_droplet_names+=("$name")
        # Optimization: reserve this name by creating a placeholder? No, generate_droplet_name checks DO.
        # Check if we have duplicates in our local list (if we generate fast)
        # Actually generate_droplet_name hits the API which is slow.
        # But if we run it sequentially here, it's safer.
        
        # NOTE: There's a race condition if we run multiple scale-up scripts at once.
        # For a single user, this is fine.
    done
    
    local names_str="${new_droplet_names[*]}"
    
    log_info "Creating droplets: ${names_str}"
    
    # Create all droplets in ONE commands for parallelism
    # Output format is ID,Name per line
    local create_output
    create_output=$(doctl compute droplet create ${names_str} \
        --size "${DO_DROPLET_SIZE}" \
        --image "${DO_IMAGE}" \
        --region "${DO_REGION}" \
        --vpc-uuid "${vpc_id}" \
        --ssh-keys "${DO_SSH_KEY_FINGERPRINT}" \
        --tag-name "${PROJECT_NAME}" \
        --enable-monitoring \
        --format ID \
        --no-header \
        --wait) # Wait for them to be "created" (Allocated), but not necessarily "active"/booted
        
    # Parse IDs
    while read -r id; do
        if [[ -n "$id" ]]; then
            new_droplet_ids+=("$id")
        fi
    done <<< "$create_output"
    
    log_success "Droplets allocated. IDs: ${new_droplet_ids[*]}"
    
    # Wait for all to be strictly ACTIVE
    log_info "Waiting for all droplets to be ACTIVE..."
    sleep 20 # Give them a head start
    
    for id in "${new_droplet_ids[@]}"; do
        wait_for_droplet "$id" || {
             log_error "Droplet $id failed to become active."
             exit 1
        }
    done
    
    # Collect IPs with validation
    local skipped_droplet_ids=()
    local skipped_droplet_names=()
    local valid_droplet_ids=()
    local valid_droplet_names=()
    
    for ((i=0; i<${#new_droplet_ids[@]}; i++)); do
        local id="${new_droplet_ids[$i]}"
        local name="${new_droplet_names[$i]}"
        local ip=""
        local cmd_exit=0
        local cmd_stderr=""
        
        # Capture output, stderr, and exit status
        local stderr_file=$(mktemp)
        ip=$(doctl compute droplet get "$id" --format PublicIPv4 --no-header 2>"$stderr_file") || cmd_exit=$?
        cmd_stderr=$(cat "$stderr_file" 2>/dev/null || echo "")
        rm -f "$stderr_file"
        
        # Check command exit status
        if [[ $cmd_exit -ne 0 ]]; then
            if [[ -n "$cmd_stderr" ]]; then
                log_error "Failed to retrieve IP for droplet $name (ID: $id). Command exited with status $cmd_exit. Error: $cmd_stderr"
            else
                log_error "Failed to retrieve IP for droplet $name (ID: $id). Command exited with status $cmd_exit."
            fi
            skipped_droplet_ids+=("$id")
            skipped_droplet_names+=("$name")
            continue
        fi
        
        # Check if IP is non-empty
        if [[ -z "$ip" ]]; then
            log_error "Empty IP address returned for droplet $name (ID: $id). Skipping."
            skipped_droplet_ids+=("$id")
            skipped_droplet_names+=("$name")
            continue
        fi
        
        # Validate IPv4 format
        if ! is_valid_ipv4 "$ip"; then
            log_error "Invalid IPv4 address format for droplet $name (ID: $id): '$ip'. Skipping."
            skipped_droplet_ids+=("$id")
            skipped_droplet_names+=("$name")
            continue
        fi
        
        # IP is valid, add to all valid arrays
        new_droplet_ips+=("$ip")
        valid_droplet_ids+=("$id")
        valid_droplet_names+=("$name")
    done
    
    # Report skipped droplets if any
    if [[ ${#skipped_droplet_ids[@]} -gt 0 ]]; then
        log_warn "Skipped ${#skipped_droplet_ids[@]} droplet(s) due to IP retrieval/validation failures:"
        for ((i=0; i<${#skipped_droplet_ids[@]}; i++)); do
            log_warn "  - ${skipped_droplet_names[$i]} (ID: ${skipped_droplet_ids[$i]})"
        done
        log_warn "These droplets will NOT be deployed or added to the load balancer."
    fi
    
    # Check if we have any valid IPs to proceed with
    if [[ ${#new_droplet_ips[@]} -eq 0 ]]; then
        log_error "No valid IP addresses retrieved. Cannot proceed with deployment."
        exit 1
    fi
    
    log_info "All droplets active. Valid IPs: ${new_droplet_ips[*]}"
    
    # Wait for SSH to be ready
    log_info "Waiting 30s for SSH to warm up..."
    sleep 30
    
    # Deploy to each droplet
    # We do this sequentially for now to keep logs readable.
    # Use valid arrays to ensure alignment (skipped droplets are excluded)
    for ((i=0; i<${#new_droplet_ips[@]}; i++)); do
        local ip="${new_droplet_ips[$i]}"
        local name="${valid_droplet_names[$i]}"
        local id="${valid_droplet_ids[$i]}"
        
        log_info "Deploying to $name ($ip)..."
        "${SCRIPT_DIR}/deploy-droplet.sh" "$ip" "$commit_sha" || {
            log_error "Failed to deploy to $name ($ip). IT WILL NOT BE ADDED TO LOAD BALANCER."
            continue
        }
        
        # Add THIS specific droplet to LB immediately after success
        # (Faster availability, incremental roll-in)
        log_info "Adding $name to load balancer..."
        doctl compute load-balancer add-droplets "$lb_id" --droplet-ids "$id"
    done
    
    log_success "Scale up processing complete!"
    echo ""
    
    # Show current status
    "${SCRIPT_DIR}/status.sh"
}

main "$@"