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

main() {
    check_doctl
    
    log_info "Setting up SSL for domain: ${AUDIO_DOMAIN}"
    
    # Check if certificate already exists in DO
    local cert_name="cert-${PROJECT_NAME}-$(date +%Y%m%d)"
    # Get all certificates with ID, Name, and DNSNames in a single call
    # Find certificate where DNSNames contains exact domain match (domain boundaries)
    # Using awk to split DNSNames on commas and check for exact match
    local matching_line=$(doctl compute certificate list --format ID,Name,DNSNames --no-header | \
        awk -v domain="$AUDIO_DOMAIN" '{
            # Extract fields: $1=ID, $2=Name, $3 onwards=DNSNames (may contain spaces)
            id = $1
            name = $2
            # Reconstruct DNSNames from remaining fields
            dns_names = ""
            for (i = 3; i <= NF; i++) {
                dns_names = (dns_names == "" ? $i : dns_names " " $i)
            }
            # Split DNSNames on commas and check each element for exact match
            n = split(dns_names, dns_array, ",")
            for (i = 1; i <= n; i++) {
                # Trim whitespace from each DNS entry
                gsub(/^[ \t]+|[ \t]+$/, "", dns_array[i])
                if (dns_array[i] == domain) {
                    print id " " name
                    exit 0
                }
            }
        }')
    
    if [[ -n "$matching_line" ]]; then
        local found_id=$(echo "$matching_line" | awk '{print $1}')
        local found_name=$(echo "$matching_line" | awk '{print $2}')
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
    
    # Try to merge with existing rules if jq is available
    if command -v jq &> /dev/null; then
        log_info "Fetching current forwarding rules to merge with new SSL configuration..."
        
        # Get LB details in JSON
        # doctl get output might be a single object or list depending on version/context, handling both
        local lb_json
        if lb_json=$(doctl compute load-balancer get "$lb_id" --output json 2>/dev/null); then
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
                    log_warn "Failed to parse forwarding rules with jq. Fallback to overwrite."
                fi
            else
                log_warn "jq failed while parsing forwarding rules. Fallback to overwrite."
                forwarding_rules=""
            fi
        else
            log_warn "Failed to fetch Load Balancer details. Fallback to overwrite."
        fi
    else
        log_warn "jq not found. Cannot merge forwarding rules safely."
        log_warn "Installing jq is recommended to preserve existing redirects (HTTP->HTTPS)."
    fi
    
    # Fallback if merging failed or jq missing
    if [[ -z "$forwarding_rules" ]]; then
        log_warn "Overwriting ALL forwarding rules with single HTTPS rule."
        log_warn "Any existing custom rules (like HTTP->HTTPS redirects) will be REMOVED."
        log_warn "You may need to manually re-add redirects after this runs."
        forwarding_rules="entry_protocol:https,entry_port:443,target_protocol:http,target_port:${SERVER_PORT},certificate_id:${CERT_ID}"
    fi

    doctl compute load-balancer update "$lb_id" \
        --forwarding-rules "$forwarding_rules"
        
    log_success "SSL configured successfully for Load Balancer!"
    log_info "https://${AUDIO_DOMAIN} should now be secure."
}

main "$@"
