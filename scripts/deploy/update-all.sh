#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Rolling Update
# =============================================================================
# Performs a zero-downtime rolling update across all droplets.
# Updates one droplet at a time to ensure availability.
# 
# Usage:
#   ./update-all.sh
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    check_doctl
    
    # Expand tilde in SSH key path and validate early (deploy-droplet uses it)
    local ssh_key_path="${DO_SSH_PRIVATE_KEY/#\~/$HOME}"
    if [[ ! -f "$ssh_key_path" ]]; then
        log_error "SSH private key not found at: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    if [[ ! -r "$ssh_key_path" ]]; then
        log_error "SSH private key is not readable: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    
    log_info "Starting rolling update..."
    
    # 1. Determine which commit SHA to deploy
    # This ensures "Consistency": All droplets get the same version of code.
    # We will try to fetch the HEAD SHA of the remote branch.
    
    log_info "Resolving commit SHA for branch '${GITHUB_BRANCH}'..."
    # Requires git to be installed locally
    if ! command -v git &> /dev/null; then
        log_warn "git not found locally. Deploying 'HEAD' (less strict consistency)."
        COMMIT_SHA=""
    else
        COMMIT_SHA=$(git ls-remote "${GITHUB_REPO}" "${GITHUB_BRANCH}" | awk '{print $1}')
        if [[ -z "${COMMIT_SHA}" ]]; then
            log_warn "Could not resolve SHA. Deploying 'HEAD'."
        else
            log_info "Pinning deployment to commit: ${COMMIT_SHA}"
        fi
    fi
    
    # Get all droplets
    # Get all droplets with robust parsing (CSV: ID,Name,IP)
    # Use JSON output to handle names with spaces and flexible network structures.
    local droplets
    if command -v jq &> /dev/null; then
        droplets=$(doctl compute droplet list --tag-name "${PROJECT_NAME}" --output json | \
                   jq -r '.[] | [.id, (.name|sub(",";" ")), ([.networks.v4[] | select(.type=="public") | .ip_address] | first // "")] | join(",")')
    elif command -v python3 &> /dev/null; then
        droplets=$(doctl compute droplet list --tag-name "${PROJECT_NAME}" --output json | \
                   python3 -c 'import sys,json; print("\n".join(["{},{},{}".format(d.get("id"),d.get("name","").replace(","," "),next((n["ip_address"] for n in d.get("networks",{}).get("v4",[]) if n.get("type")=="public"),"")) for d in json.load(sys.stdin)]))')
    else
        log_warn "Neither 'jq' nor 'python3' found. Falling back to fragile column parsing."
        droplets=$(doctl compute droplet list --tag-name "${PROJECT_NAME}" --format ID,Name,PublicIPv4 --no-header | awk '{print $1 "," $2 "," $3}')
    fi
    
    if [[ -z "$droplets" ]]; then
        log_error "No droplets found with tag '${PROJECT_NAME}'"
        exit 1
    fi
    
    local droplet_count=$(echo "$droplets" | wc -l)
    log_info "Found ${droplet_count} droplet(s) to update"
    
    # Get Load Balancer ID
    local lb_id=$(get_lb_id)
    if [[ -z "$lb_id" ]]; then
        log_warn "Load Balancer not found, updating without LB management"
    fi
    
    # Pre-check: Verify deploy-droplet.sh exists and is executable
    if [[ ! -x "${SCRIPT_DIR}/deploy-droplet.sh" ]]; then
        log_error "Deployment helper script not found or not executable: ${SCRIPT_DIR}/deploy-droplet.sh"
        exit 1
    fi

    local success_count=0
    local fail_count=0
    local current=0
    
    # Safety: Don't update if only 1 node in LB? 
    # Actually, for 1 node, we have to outage it to update it unless we do blue/green.
    # Rolling update on 1 node = Downtime.
    if [[ "$droplet_count" -eq 1 ]]; then
        log_warn "CAUTION: Updating a single-node cluster will cause temporary downtime during container restart."
        log_info "Waiting 5 seconds before proceeding..."
        sleep 5
    fi
    
    # Update each droplet one at a time
    while IFS=',' read -r droplet_id droplet_name droplet_ip; do
        current=$((current + 1))
        
        echo ""
        log_info "=== Updating ${droplet_name} (${current}/${droplet_count}) ==="
        
        # Step 1: Remove from load balancer (Drain)
        if [[ -n "$lb_id" && "$droplet_count" -gt 1 ]]; then
            log_info "Removing from load balancer..."
            if ! doctl compute load-balancer remove-droplets "$lb_id" --droplet-ids "$droplet_id"; then
                log_warn "Failed to remove droplet from LB, proceeding with update anyway"
            fi
            
            # Brief wait for LB to stop sending NEW traffic
            log_info "Draining connections..."
            sleep 10
        fi
        
        # Step 2: Update the droplet
        log_info "Deploying update to ${droplet_ip}..."
        # Pass the PINNED commit SHA
        if "${SCRIPT_DIR}/deploy-droplet.sh" "$droplet_ip" "$COMMIT_SHA"; then
            log_success "Update successful"
            success_count=$((success_count + 1))
        else
            log_error "Update failed for ${droplet_name}"
            fail_count=$((fail_count + 1))
            
            # If update failed, try to add it back to LB anyway so we don't lose capacity?
            # Or leave it out? Safer to leave it out/quarantine it.
            log_warn "Node ${droplet_name} left OUT of load balancer due to failure."
            
            # Abort strictly if simple update?
            # log_error "Aborting remaining updates to prevent cascade failure."
            # exit 1
            continue 
        fi
        
        # Step 3: Add back to load balancer
        if [[ -n "$lb_id" && "$droplet_count" -gt 1 ]]; then
            log_info "Adding back to load balancer..."
            if ! doctl compute load-balancer add-droplets "$lb_id" --droplet-ids "$droplet_id"; then
                log_error "Failed to add droplet back to LB after update"
                fail_count=$((fail_count + 1))
                success_count=$((success_count - 1))
                continue
            fi
            
            # Wait for health check to pass (LB needs time to see it as healthy)
            log_info "Waiting for LB health checks..."
            sleep 15
        fi
        
    done <<< "$droplets"
    
    # Summary
    echo ""
    echo "=============================================="
    echo "  Rolling Update Complete"
    echo "=============================================="
    echo ""
    log_info "Results: ${success_count} succeeded, ${fail_count} failed"
    
    if [[ $fail_count -gt 0 ]]; then
        log_error "Some updates failed. Check the logs above."
        exit 1
    fi
    
    log_success "All droplets updated successfully!"
}

main "$@"
