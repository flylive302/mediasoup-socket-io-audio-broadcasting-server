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
    
    doctl compute load-balancer update "$lb_id" \
        --forwarding-rules "entry_protocol:https,entry_port:443,target_protocol:http,target_port:${SERVER_PORT},certificate_id:${CERT_ID}"
        
    log_success "SSL configured successfully for Load Balancer!"
    log_info "https://${AUDIO_DOMAIN} should now be secure."
}

main "$@"
