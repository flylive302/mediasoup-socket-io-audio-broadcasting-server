#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Scale Down
# =============================================================================
# Gracefully remove a droplet from the cluster.
# 
# Usage:
#   ./scale-down.sh <droplet-name>
#   ./scale-down.sh flylive-audio-03
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    local droplet_name="$1"
    
    check_doctl
    
    # Expand tilde in SSH key path and validate
    local ssh_key_path="${DO_SSH_PRIVATE_KEY/#\~/$HOME}"
    if [[ ! -f "$ssh_key_path" ]]; then
        log_error "SSH private key not found at: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    if [[ ! -r "$ssh_key_path" ]]; then
        log_error "SSH private key is not readable: ${DO_SSH_PRIVATE_KEY}"
        exit 1
    fi
    
    log_info "Scaling down: Removing droplet '${droplet_name}'..."
    
    # Get droplet info using JSON for robust parsing
    local droplet_id=""
    local droplet_ip=""
    
    if command -v jq &> /dev/null; then
        # Use JSON output with jq for exact name matching
        # This ensures we only match the exact droplet name, not partial matches
        # Use --arg to safely pass shell variable to jq (prevents injection/breaking on special chars)
        local droplet_json=$(doctl compute droplet list --output json 2>/dev/null | \
            jq -r --arg name "$droplet_name" '.[] | select(.name == $name)' 2>/dev/null | head -n1 || echo "")
        
        if [[ -n "$droplet_json" && "$droplet_json" != "null" && "$droplet_json" != "" ]]; then
            droplet_id=$(echo "$droplet_json" | jq -r '.id // empty' 2>/dev/null)
            # Get the first public IPv4 address
            droplet_ip=$(echo "$droplet_json" | jq -r '.networks.v4[]? | select(.type == "public") | .ip_address' 2>/dev/null | head -n1)
            
            # Validate we got both values
            if [[ -n "$droplet_id" && "$droplet_id" != "null" && -n "$droplet_ip" && "$droplet_ip" != "null" ]]; then
                # Successfully parsed from JSON
                :
            else
                # Reset to force fallback
                droplet_id=""
                droplet_ip=""
            fi
        fi
    fi
    
    # Fallback to JSON-to-CSV conversion if jq not available or JSON method failed
    if [[ -z "$droplet_id" || -z "$droplet_ip" ]]; then
        # Use JSON output and convert to CSV format for reliable parsing when names contain spaces
        # Convert JSON to comma-separated format: ID,Name,PublicIPv4
        local droplet_csv=""
        
        # Try Python first (most reliable for JSON to CSV conversion)
        if command -v python3 &> /dev/null; then
            droplet_csv=$(doctl compute droplet list --output json 2>/dev/null | \
                python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for droplet in data:
        if droplet.get('name') == sys.argv[1]:
            ip = ''
            for net in droplet.get('networks', {}).get('v4', []):
                if net.get('type') == 'public':
                    ip = net.get('ip_address', '')
                    break
            print(f\"{droplet.get('id', '')},{droplet.get('name', '')},{ip}\")
            sys.exit(0)
except:
    sys.exit(1)
" "$droplet_name" 2>/dev/null || echo "")
        fi
        
        # If Python conversion succeeded, parse CSV with awk
        if [[ -n "$droplet_csv" ]]; then
            # Parse CSV fields: ID is first field, Name is second, IP is third
            # Use awk with comma delimiter to handle names with spaces correctly
            droplet_id=$(echo "$droplet_csv" | awk -F',' '{print $1}' | xargs)
            droplet_ip=$(echo "$droplet_csv" | awk -F',' '{print $3}' | xargs)
        else
            # Fallback: Parse JSON directly with simpler tools (less reliable but works)
            local all_json=$(doctl compute droplet list --output json 2>/dev/null || echo "")
            if [[ -z "$all_json" ]]; then
                log_error "Failed to retrieve droplet list from DigitalOcean"
                exit 1
            fi
            
            # Extract the droplet object for the matching name
            # Use a simple approach: find the JSON object containing the name
            local droplet_block=$(echo "$all_json" | awk -v name="$droplet_name" '
                BEGIN { RS="}"; found=0 }
                {
                    if ($0 ~ "\"name\":\"" name "\"") {
                        print $0 "}"
                        found=1
                        exit
                    }
                }
                END { if (!found) exit 1 }
            ' 2>/dev/null || echo "")
            
            if [[ -z "$droplet_block" ]]; then
                log_error "Droplet '${droplet_name}' not found"
                exit 1
            fi
            
            # Extract ID from the droplet block
            droplet_id=$(echo "$droplet_block" | grep -oE '"id":\s*[0-9]+' | grep -oE '[0-9]+' | head -n1)
            
            # Extract public IPv4 - find ip_address in v4 networks with type public
            droplet_ip=$(echo "$droplet_block" | \
                awk '/"v4":\s*\[/,/\]/ { 
                    if (/"type":\s*"public"/) {
                        getline
                        if (/"ip_address":/) {
                            gsub(/.*"ip_address":\s*"|".*/, "")
                            if ($0 ~ /^[0-9.]+$/) print $0
                        }
                    }
                }' | head -n1)
        fi
        
        if [[ -z "$droplet_id" || -z "$droplet_ip" ]]; then
            log_error "Droplet '${droplet_name}' not found or failed to parse"
            exit 1
        fi
        
        # Validate parsing succeeded
        if [[ ! "$droplet_id" =~ ^[0-9]+$ ]]; then
            log_error "Invalid droplet ID parsed: '${droplet_id}'"
            exit 1
        fi
    fi
    
    log_info "Found droplet: ID=${droplet_id}, IP=${droplet_ip}"
    
    # Safety Check: Load Balancer Health
    local lb_id=$(get_lb_id)
    
    # Precompute re-add command for abort messages (works even if lb_id is empty)
    local readd_cmd="doctl compute load-balancer add-droplets ${lb_id:-'LB-ID'} --droplet-ids ${droplet_id:-'DROPLET-ID'}"
    if [[ -n "$lb_id" ]]; then
        # Count droplets in LB
        local lb_droplets=$(doctl compute load-balancer get "$lb_id" --format DropletIDs --no-header)
        
        # Validate and parse lb_droplets with robust error handling
        # Trim whitespace
        lb_droplets=$(echo "$lb_droplets" | xargs)
        
        # Check if input is non-empty
        if [[ -z "$lb_droplets" ]]; then
            log_error "ABORTING: Load balancer droplet list is empty or invalid"
            log_error "Cannot safely determine droplet count for scale-down operation"
            exit 1
        fi
        
        # Split on commas and build validated array
        local lb_droplet_ids=()
        local invalid_tokens=()
        IFS=',' read -ra raw_tokens <<< "$lb_droplets"
        
        for token in "${raw_tokens[@]}"; do
            # Trim whitespace from each token
            token=$(echo "$token" | xargs)
            
            # Skip empty tokens
            if [[ -z "$token" ]]; then
                continue
            fi
            
            # Validate token is numeric (droplet IDs are numeric)
            if [[ "$token" =~ ^[0-9]+$ ]]; then
                lb_droplet_ids+=("$token")
            else
                invalid_tokens+=("$token")
            fi
        done
        
        # Check if we have any valid droplet IDs
        if [[ ${#lb_droplet_ids[@]} -eq 0 ]]; then
            log_error "ABORTING: No valid droplet IDs found in load balancer"
            if [[ ${#invalid_tokens[@]} -gt 0 ]]; then
                log_error "Invalid tokens found: ${invalid_tokens[*]}"
            fi
            log_error "Cannot safely determine droplet count for scale-down operation"
            exit 1
        fi
        
        # Warn about invalid tokens but continue if we have valid ones
        if [[ ${#invalid_tokens[@]} -gt 0 ]]; then
            log_warn "Found ${#invalid_tokens[@]} invalid token(s) in load balancer droplet list: ${invalid_tokens[*]}"
            log_warn "Proceeding with ${#lb_droplet_ids[@]} valid droplet ID(s)"
        fi
        
        local initial_count=${#lb_droplet_ids[@]}
        
        log_info "Load Balancer currently has ${initial_count} droplets"
        
        if [[ "$initial_count" -le 1 ]]; then
            log_error "ABORTING: This is the LAST droplet in the Load Balancer."
            log_error "Removing it would cause a total outage."
            exit 1
        fi
    else
        log_warn "Load Balancer not found, skipping LB removal safety check"
    fi
    
    # Confirm destruction
    echo ""
    local confirm=""
    while true; do
        read -p "Destroy droplet '${droplet_name}' (${droplet_id})? [y/N] " confirm
        # Trim and lowercase the input
        confirm=$(echo "$confirm" | tr '[:upper:]' '[:lower:]' | xargs)
        
        # Check for valid answers
        if [[ "$confirm" == "y" || "$confirm" == "yes" ]]; then
            break
        elif [[ "$confirm" == "n" || "$confirm" == "no" || -z "$confirm" ]]; then
            log_info "Aborted. Droplet NOT destroyed."
            exit 0
        else
            echo "Please enter 'y', 'yes', 'n', or 'no'"
        fi
    done
    
    # User confirmed destruction - proceed with removal operations
    # Remove from load balancer
    if [[ -n "$lb_id" ]]; then
        log_info "Removing from load balancer..."
        doctl compute load-balancer remove-droplets "$lb_id" --droplet-ids "$droplet_id" || {
            log_error "Failed to remove droplet from load balancer"
            log_error "Droplet may still be attached to load balancer"
            exit 1
        }
    fi
    
    # Wait for connections to drain
    log_info "Waiting ${DRAIN_TIMEOUT}s for connections to drain..."
    sleep "${DRAIN_TIMEOUT}"
    
    # Stop the container
    log_info "Stopping container on ${droplet_ip}..."
    local ssh_output=""
    local ssh_exit_code=0
    
    # Capture SSH command output and exit code
    # Redirect stderr to stdout to capture all output
    ssh_output=$(ssh -i "${ssh_key_path}" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=10 \
        "root@${droplet_ip}" \
        "docker stop ${CONTAINER_NAME}" 2>&1) || ssh_exit_code=$?
    
    # Check if SSH itself failed (connection/authentication issues)
    # SSH typically returns 255 for connection failures, but we also check output for connection errors
    if [[ $ssh_exit_code -eq 255 ]] || echo "$ssh_output" | grep -qiE "(connection refused|connection timed out|could not resolve|permission denied|authentication failed|ssh.*failed)"; then
        log_error "SSH connection failed (exit code: ${ssh_exit_code})"
        log_error "Could not connect to ${droplet_ip} to stop container"
        if [[ -n "$ssh_output" ]]; then
            log_error "SSH error output: ${ssh_output}"
        fi
    elif [[ $ssh_exit_code -ne 0 ]]; then
        # SSH succeeded but remote docker stop command failed
        # Check for benign "no such container" errors
        if echo "$ssh_output" | grep -qiE "(no such container|cannot find.*container|could not find.*container|Error: No such container)"; then
            log_warn "Container '${CONTAINER_NAME}' not found on ${droplet_ip} (may already be stopped)"
            if [[ -n "$ssh_output" ]]; then
                log_warn "Remote output: ${ssh_output}"
            fi
        else
            # Container stop failed for other reasons
            log_error "Failed to stop container '${CONTAINER_NAME}' on ${droplet_ip} (remote exit code: ${ssh_exit_code})"
            if [[ -n "$ssh_output" ]]; then
                log_error "Remote command output: ${ssh_output}"
            fi
        fi
    fi
    # If ssh_exit_code is 0, docker stop succeeded (no action needed)
    
    # Destroy droplet
    log_info "Destroying droplet..."
    doctl compute droplet delete "$droplet_id" --force
    
    log_success "Droplet '${droplet_name}' has been destroyed"
    echo ""
    
    # Show current status
    "${SCRIPT_DIR}/status.sh"
}

# Show usage if no argument
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <droplet-name>"
    echo ""
    echo "Current droplets:"
    doctl compute droplet list --tag-name "${PROJECT_NAME:-flylive-audio}" --format Name,PublicIPv4,Status --no-header 2>/dev/null || echo "  (none found)"
    exit 1
fi

main "$1"
