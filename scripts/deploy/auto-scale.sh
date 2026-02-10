#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Auto-Scaler
# =============================================================================
# Metrics-driven auto-scaling based on /metrics endpoint data.
# Runs via cron every 5 minutes to check load and scale up/down.
#
# Install:
#   crontab -e
#   */5 * * * * /opt/audio-server/scripts/deploy/auto-scale.sh >> /var/log/flylive-autoscale.log 2>&1
#
# Required: doctl CLI authenticated, config.sh accessible
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# =============================================================================
# Auto-Scale Configuration
# =============================================================================

# Thresholds (connections per droplet)
SCALE_UP_THRESHOLD="${SCALE_UP_THRESHOLD:-15000}"
SCALE_DOWN_THRESHOLD="${SCALE_DOWN_THRESHOLD:-3000}"

# How many droplets to add/remove per scale event
SCALE_UP_COUNT="${SCALE_UP_COUNT:-1}"

# Minimum droplets (never scale below this)
MIN_DROPLETS="${MIN_DROPLETS:-1}"

# Maximum droplets (budget safety)
MAX_DROPLETS="${MAX_DROPLETS:-20}"

# Cooldown: minimum seconds between scale events
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-600}"  # 10 minutes

# Lock file to prevent concurrent runs
LOCK_FILE="/tmp/flylive-autoscale.lock"

# State file to track last scale event
STATE_FILE="/tmp/flylive-autoscale-state"

# =============================================================================
# Helpers
# =============================================================================

cleanup() {
    rm -f "${LOCK_FILE}"
}
trap cleanup EXIT

acquire_lock() {
    if [[ -f "${LOCK_FILE}" ]]; then
        local lock_pid
        lock_pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
        if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
            log_info "Another auto-scale run is in progress (PID: ${lock_pid}), skipping"
            exit 0
        fi
        # Stale lock file
        rm -f "${LOCK_FILE}"
    fi
    echo $$ > "${LOCK_FILE}"
}

check_cooldown() {
    if [[ -f "${STATE_FILE}" ]]; then
        local last_event
        last_event=$(cat "${STATE_FILE}" 2>/dev/null || echo "0")
        local now
        now=$(date +%s)
        local elapsed=$((now - last_event))
        if [[ ${elapsed} -lt ${COOLDOWN_SECONDS} ]]; then
            local remaining=$((COOLDOWN_SECONDS - elapsed))
            log_info "Cooldown active: ${remaining}s remaining since last scale event"
            exit 0
        fi
    fi
}

record_scale_event() {
    date +%s > "${STATE_FILE}"
}

# Get active socket connections from a droplet's /metrics endpoint
get_droplet_connections() {
    local ip="$1"
    local response
    response=$(curl -sf --max-time 5 "http://${ip}:${SERVER_PORT}/metrics" 2>/dev/null || echo "")
    
    if [[ -z "${response}" ]]; then
        echo "0"
        return
    fi
    
    # Parse JSON: extract application.rooms (as a proxy for load)
    # Using grep/sed for portability (no jq dependency)
    local rooms
    rooms=$(echo "${response}" | grep -o '"rooms":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "0")
    local workers
    workers=$(echo "${response}" | grep -o '"activeWorkers":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "0")
    
    echo "${rooms}"
}

# =============================================================================
# Main Logic
# =============================================================================

main() {
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo ""
    echo "=============================================="
    echo "  Auto-Scale Check: ${timestamp}"
    echo "=============================================="

    check_doctl
    acquire_lock
    check_cooldown

    # Get all active droplets
    local droplet_list
    droplet_list=$(get_all_droplets) || {
        log_error "Failed to get droplet list"
        exit 1
    }

    if [[ -z "${droplet_list}" ]]; then
        log_error "No droplets found with tag '${PROJECT_NAME}'"
        exit 1
    fi

    # Count droplets and gather metrics
    local droplet_count=0
    local total_rooms=0
    local droplet_ips=()

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        local name ip status
        name=$(echo "$line" | awk '{print $1}')
        ip=$(echo "$line" | awk '{print $2}')
        status=$(echo "$line" | awk '{print $3}')

        if [[ "${status}" != "active" ]]; then
            log_warn "Droplet ${name} is not active (status: ${status})"
            continue
        fi

        droplet_count=$((droplet_count + 1))
        droplet_ips+=("${ip}")

        local rooms
        rooms=$(get_droplet_connections "${ip}")
        total_rooms=$((total_rooms + rooms))

        log_info "Droplet ${name} (${ip}): ${rooms} rooms"
    done <<< "${droplet_list}"

    if [[ ${droplet_count} -eq 0 ]]; then
        log_error "No active droplets found"
        exit 1
    fi

    local avg_rooms=$((total_rooms / droplet_count))

    echo ""
    log_info "Summary: ${droplet_count} droplets, ${total_rooms} total rooms, ${avg_rooms} avg rooms/droplet"
    log_info "Thresholds: scale-up > ${SCALE_UP_THRESHOLD}, scale-down < ${SCALE_DOWN_THRESHOLD}"

    # Scale UP decision
    if [[ ${avg_rooms} -gt ${SCALE_UP_THRESHOLD} ]]; then
        if [[ ${droplet_count} -ge ${MAX_DROPLETS} ]]; then
            log_warn "Load is high (avg ${avg_rooms} rooms) but already at max droplets (${MAX_DROPLETS})"
        else
            log_info "SCALING UP: avg rooms (${avg_rooms}) > threshold (${SCALE_UP_THRESHOLD})"
            log_info "Adding ${SCALE_UP_COUNT} droplet(s)..."
            
            "${SCRIPT_DIR}/scale-up.sh" "${SCALE_UP_COUNT}"
            record_scale_event
            
            log_success "Scale-up complete"
        fi
        return
    fi

    # Scale DOWN decision
    if [[ ${avg_rooms} -lt ${SCALE_DOWN_THRESHOLD} ]] && [[ ${droplet_count} -gt ${MIN_DROPLETS} ]]; then
        log_info "SCALING DOWN: avg rooms (${avg_rooms}) < threshold (${SCALE_DOWN_THRESHOLD})"
        
        # Find the least-loaded droplet to remove
        local min_rooms=999999
        local target_droplet=""
        
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local name ip status
            name=$(echo "$line" | awk '{print $1}')
            ip=$(echo "$line" | awk '{print $2}')
            status=$(echo "$line" | awk '{print $3}')
            
            [[ "${status}" != "active" ]] && continue
            
            local rooms
            rooms=$(get_droplet_connections "${ip}")
            
            if [[ ${rooms} -lt ${min_rooms} ]]; then
                min_rooms=${rooms}
                target_droplet="${name}"
            fi
        done <<< "${droplet_list}"
        
        if [[ -n "${target_droplet}" ]]; then
            log_info "Removing least-loaded droplet: ${target_droplet} (${min_rooms} rooms)"
            
            # scale-down.sh uses --yes flag for non-interactive mode
            "${SCRIPT_DIR}/scale-down.sh" "${target_droplet}" --yes
            record_scale_event
            
            log_success "Scale-down complete"
        fi
        return
    fi

    log_info "No scaling action needed (avg rooms: ${avg_rooms})"
}

# Run main
main "$@"
