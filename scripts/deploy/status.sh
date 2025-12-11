#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Infrastructure Status
# =============================================================================
# Shows the current status of all audio server infrastructure.
# 
# Usage:
#   ./status.sh
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    echo ""
    echo "=============================================="
    echo "  FlyLive Audio Server - Infrastructure Status"
    echo "=============================================="
    echo ""
    
    # Check if doctl is available
    if ! command -v doctl &> /dev/null; then
        log_error "doctl CLI not installed"
        exit 1
    fi
    
    if ! doctl account get &> /dev/null 2>&1; then
        log_error "doctl not authenticated. Run: doctl auth init"
        exit 1
    fi
    
    # Droplets
    echo "DROPLETS"
    echo "--------"
    local droplets=$(doctl compute droplet list --tag-name "${PROJECT_NAME}" --format Name,PublicIPv4,Memory,VCPUs,Status --no-header 2>/dev/null || echo "")
    
    if [[ -z "$droplets" ]]; then
        echo "  No droplets found with tag '${PROJECT_NAME}'"
    else
        local droplet_count=$(echo "$droplets" | wc -l)
        local total_vcpus=0
        while IFS= read -r line; do
            local name=$(echo "$line" | awk '{print $1}')
            local ip=$(echo "$line" | awk '{print $2}')
            local mem=$(echo "$line" | awk '{print $3}')
            local vcpus=$(echo "$line" | awk '{print $4}')
            local status=$(echo "$line" | awk '{print $5}')
            total_vcpus=$((total_vcpus + vcpus))
            
            if curl -sf --max-time 5 "http://${ip}:${SERVER_PORT}/health" > /dev/null 2>&1; then
                health="${GREEN}healthy${NC}"
            else
                health="${RED}unhealthy${NC}"
            fi
                health="${RED}unhealthy${NC}"
            fi
            
            printf "  %-20s %-16s %4s vCPUs  %6s MB  %-10s %b\n" "$name" "$ip" "$vcpus" "$mem" "$status" "$health"
        done <<< "$droplets"
        
        echo ""
        echo "  Total: ${droplet_count} droplet(s)"
        
        # Estimate capacity (rough: 2,500 users per vCPU)
        local estimated_capacity=$((total_vcpus * 2500))
        echo "  Estimated capacity: ~${estimated_capacity} concurrent users"
    fi
    echo ""
    
    # Load Balancer
    echo "LOAD BALANCER"
    echo "-------------"
    local lb_info=$(doctl compute load-balancer list --format Name,IP,Status,DropletIDs --no-header 2>/dev/null | grep -E "^${LB_NAME}[[:space:]]" || echo "")
    
    if [[ -z "$lb_info" ]]; then
        echo "  No load balancer found with name '${LB_NAME}'"
    else
        local lb_ip=$(echo "$lb_info" | awk '{print $2}')
        local lb_status=$(echo "$lb_info" | awk '{print $3}')
        echo "  Name: ${LB_NAME}"
        echo "  IP: ${lb_ip}"
        echo "  Status: ${lb_status}"
        echo "  Domain: ${AUDIO_DOMAIN} -> ${lb_ip}"
    fi
    echo ""
    
    # Valkey (Redis-compatible)
    echo "VALKEY CLUSTER"
    echo "-------------"
    local valkey_info=$(doctl databases list --format Name,Engine,Status,Size --no-header 2>/dev/null | grep -E "^${VALKEY_NAME}[[:space:]]" || echo "")
    
    if [[ -z "$valkey_info" ]]; then
        echo "  No Valkey cluster found with name '${VALKEY_NAME}'"
    else
        local valkey_status=$(echo "$valkey_info" | awk '{print $3}')
        local valkey_size=$(echo "$valkey_info" | awk '{print $4}')
        echo "  Name: ${VALKEY_NAME}"
        echo "  Status: ${valkey_status}"
        echo "  Size: ${valkey_size}"
    fi
    echo ""
    
    # VPC
    echo "VPC NETWORK"
    echo "-----------"
    local vpc_info=$(doctl vpcs list --format Name,IPRange,Region --no-header 2>/dev/null | grep -E "^${VPC_NAME}[[:space:]]" || echo "")
    
    if [[ -z "$vpc_info" ]]; then
        echo "  No VPC found with name '${VPC_NAME}'"
    else
        echo "  Name: ${VPC_NAME}"
        echo "  IP Range: $(echo "$vpc_info" | awk '{print $2}')"
        echo "  Region: $(echo "$vpc_info" | awk '{print $3}')"
    fi
    echo ""
    
    # Firewall
    echo "FIREWALL"
    echo "--------"
    local fw_info=$(doctl compute firewall list --format Name,Status --no-header 2>/dev/null | grep -E "^${FIREWALL_NAME}[[:space:]]" || echo "")
    
    if [[ -z "$fw_info" ]]; then
        echo "  No firewall found with name '${FIREWALL_NAME}'"
    else
        echo "  Name: ${FIREWALL_NAME}"
        echo "  Ports: 22/tcp, ${SERVER_PORT}/tcp, ${RTC_MIN_PORT}-${RTC_MAX_PORT}/udp+tcp"
    fi
    echo ""
    
    # Quick test
    echo "QUICK HEALTH CHECK"
    echo "------------------"
    if [[ -n "${lb_info:-}" ]]; then
        if curl -sf --max-time 5 "http://${lb_ip}:80/health" > /dev/null 2>&1; then
            log_success "Load Balancer health check: PASSED"
        else
            log_warn "Load Balancer health check: FAILED (check SSL or port config)"
        fi
        fi
    fi
    echo ""
}

main "$@"
