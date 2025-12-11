#!/bin/bash
# =============================================================================
# FlyLive Audio Server - SSL Setup
# =============================================================================
# Automates adding a Let's Encrypt certificate to Digital Ocean Load Balancers.
# 
# Usage:
#   ./setup-ssl.sh
# =============================================================================

set -euo pipefail

# Load configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

FORCE_OVERWRITE=false

parse_args() {
    for arg in "$@"; do
        case "$arg" in
            --force|-f)
                FORCE_OVERWRITE=true
                ;;
            *)
                log_error "Unknown argument: ${arg}"
                exit 1
                ;;
        esac
    done
}

main() {
    parse_args "$@"
    check_doctl
    
    if ! command -v jq &> /dev/null; then
        log_error "jq is required to parse DigitalOcean responses. Install jq (e.g. sudo apt-get install jq) and re-run setup-ssl.sh."
        exit 1
    fi
    
    if [[ -z "${AUDIO_DOMAIN:-}" ]]; then
        log_error "AUDIO_DOMAIN is not set. Update .env.deploy before running setup-ssl.sh."
        exit 1
    fi
    
    log_info "Setting up SSL for domain: ${AUDIO_DOMAIN}"
    
    # Check if certificate already exists in DO
    local cert_name="cert-${PROJECT_NAME}-$(date +%Y%m%d)"
    # Query certificates in JSON and find one whose dns_names contains AUDIO_DOMAIN
    local certificates_json
    certificates_json=$(doctl compute certificate list --output json)
    local matching_line=$(echo "$certificates_json" | jq -r --arg domain "$AUDIO_DOMAIN" '
        map(select((.dns_names // []) | index($domain))) |
        if length == 0 then empty else .[0] | "\(.id) \(.name)" end
    ')
    local matching_count=$(echo "$certificates_json" | jq -r --arg domain "$AUDIO_DOMAIN" '
        map(select((.dns_names // []) | index($domain))) | length
    ')
    
    if [[ -n "$matching_line" ]]; then
        local found_id=$(echo "$matching_line" | awk '{print $1}')
        local found_name=$(echo "$matching_line" | awk '{print $2}')
        if [[ "${matching_count:-0}" -gt 1 ]]; then
            log_warn "Multiple certificates match ${AUDIO_DOMAIN}; using first result."
        fi
        log_success "Certificate already exists: ${found_name}"
        CERT_ID="$found_id"
    else
        log_info "Creating new Let's Encrypt certificate via Digital Ocean..."
        log_warn "NOTE: This requires your domain's DNS to be managed by Digital Ocean!"
        
        # Create Let's Encrypt certificate
        # Validates via DNS automatically if domain is on DO
        local cert_out
        if cert_out=$(doctl compute certificate create \
            --name "${cert_name}" \
            --type lets_encrypt \
            --dns-names "${AUDIO_DOMAIN}" \
            --format ID \
            --no-header 2>&1); then
            
            CERT_ID=$(echo "$cert_out" | awk '{print $1}')
            log_success "Created certificate '${cert_name}' (ID: ${CERT_ID})"
        else
            log_error "Failed to create certificate."
            echo "$cert_out"
            echo ""
            echo "Possible reasons:"
            echo "1. Domain '${AUDIO_DOMAIN}' is not managed by Digital Ocean DNS."
            echo "2. CAA records block Let's Encrypt."
            echo ""
            echo "If you use an external DNS provider (GoDaddy, Cloudflare, etc.), you must:"
            echo "1. Generate a certificate manually (e.g., passing challenges)."
            echo "2. Upload it: doctl compute certificate create --name ... --leaf-certificate-path ... --private-key-path ..."
            exit 1
        fi
    fi
    
    # Attach to Load Balancer
    local lb_id=$(get_lb_id)
    if [[ -z "$lb_id" ]]; then
        log_error "Load Balancer '${LB_NAME}' not found. Run setup-infrastructure.sh first."
        exit 1
    fi
    
    log_info "Updating Load Balancer to use certificate..."
    
    # We need to update the forwarding rules to use this certificate
    # entry_protocol:https,entry_port:443,target_protocol:http,target_port:3030,certificate_id:UUID
    
    local forwarding_rules=""
    local lb_json=""
    local existing_forwarding_rules=""
    
    log_info "Fetching current forwarding rules to merge with new SSL configuration..."
    
    # Get LB details in JSON
    # doctl get output might be a single object or list depending on version/context, handling both
    if lb_json=$(doctl compute load-balancer get "$lb_id" --output json 2>/dev/null); then
        existing_forwarding_rules=$(echo "$lb_json" | jq -r '
            (if type=="array" then .[0] else . end) | .forwarding_rules |
            map(
                "entry_protocol:" + .entry_protocol +
                ",entry_port:" + (.entry_port | tostring) +
                ",target_protocol:" + .target_protocol +
                ",target_port:" + (.target_port | tostring) +
                (if .certificate_id and .certificate_id != "" then ",certificate_id:" + .certificate_id else "" end)
            ) | join(" ")
        ' 2>/dev/null || true)
        
        # Use jq to update or append the HTTPS rule while preserving others
        if forwarding_rules=$(echo "$lb_json" | jq -r --arg CERT_ID "$CERT_ID" --arg SERVER_PORT "$SERVER_PORT" '
                (if type=="array" then .[0] else . end) | .forwarding_rules as $rules |
                $rules |
                if (map(select(.entry_port == 443)) | length) > 0 then
                    map(if .entry_port == 443 then 
                        . + {
                            "entry_protocol": "https",
                            "entry_port": 443,
                            "target_protocol": "http",
                            "target_port": ($SERVER_PORT | tonumber),
                            "certificate_id": $CERT_ID
                        }
                    else . end)
                else
                    . + [{
                        "entry_protocol": "https",
                        "entry_port": 443,
                        "target_protocol": "http",
                        "target_port": ($SERVER_PORT | tonumber),
                        "certificate_id": $CERT_ID
                    }]
                end |
                map(
                    "entry_protocol:" + .entry_protocol +
                    ",entry_port:" + (.entry_port | tostring) +
                    ",target_protocol:" + .target_protocol +
                    ",target_port:" + (.target_port | tostring) +
                    (if .certificate_id and .certificate_id != "" then ",certificate_id:" + .certificate_id else "" end)
                ) |
                join(" ")
            ' 2>/dev/null); then
            if [[ -n "$forwarding_rules" ]]; then
                log_info "Merged forwarding rules: $forwarding_rules"
            else
                log_warn "Failed to parse forwarding rules with jq; no changes applied yet."
            fi
        else
            log_error "jq failed while parsing forwarding rules. Aborting without changes."
            exit 1
        fi
    else
        log_error "Failed to fetch Load Balancer details. Aborting without changes."
        exit 1
    fi
    
    # Fallback if merging failed
    if [[ -z "$forwarding_rules" ]]; then
        local backup_dir="${SCRIPT_DIR}/backups"
        mkdir -p "$backup_dir"
        local timestamp
        timestamp="$(date +%Y%m%d%H%M%S)"
        local backup_rules_path="${backup_dir}/forwarding_rules_${LB_NAME}_${timestamp}.txt"
        
        if [[ -n "$existing_forwarding_rules" ]]; then
            echo "$existing_forwarding_rules" > "$backup_rules_path"
        else
            backup_rules_path="${backup_dir}/forwarding_rules_${LB_NAME}_${timestamp}.json"
            echo "$lb_json" > "$backup_rules_path"
        fi
        
        log_error "Could not safely merge forwarding rules; no updates applied."
        log_info "Backup of current forwarding rules saved to: ${backup_rules_path}"
        log_info "To restore: doctl compute load-balancer update \"$lb_id\" --forwarding-rules \"$(cat "${backup_rules_path}")\""
        
        if [[ "$FORCE_OVERWRITE" != "true" ]]; then
            if [[ -t 0 ]]; then
                read -r -p "Type 'overwrite' to replace ALL forwarding rules with HTTPS-only: " confirmation
                if [[ "$confirmation" != "overwrite" ]]; then
                    log_error "Confirmation not received; aborting without changes. Re-run with --force to skip the prompt."
                    exit 1
                fi
            else
                log_error "Re-run with --force to overwrite all forwarding rules with a single HTTPS rule after reviewing the backup."
                exit 1
            fi
        else
            log_warn "--force supplied: proceeding to overwrite ALL forwarding rules after backup."
        fi
        
        forwarding_rules="entry_protocol:https,entry_port:443,target_protocol:http,target_port:${SERVER_PORT},certificate_id:${CERT_ID}"
    fi

    doctl compute load-balancer update "$lb_id" \
        --forwarding-rules "$forwarding_rules"
        
    log_success "SSL configured successfully for Load Balancer!"
    log_info "https://${AUDIO_DOMAIN} should now be secure."
}

main "$@"
