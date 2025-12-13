#!/bin/bash
# =============================================================================
# FlyLive Audio Server - Deployment Configuration
# =============================================================================
# 
# This script reads configuration from .env file for security.
# Copy .env.example to .env and fill in your values.
#
# =============================================================================

set -euo pipefail

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# -----------------------------------------------------------------------------
# Load .env file
# -----------------------------------------------------------------------------

# Require .env.deploy for deployment
if [[ -f "${PROJECT_ROOT}/.env.deploy" ]]; then
    echo "✅  Loading configuration from .env.deploy"
    set -a
    source "${PROJECT_ROOT}/.env.deploy"
    set +a
else
    echo "❌  ERROR: .env.deploy file not found!"
    echo "   Create .env.deploy with your deployment values."
    echo "   Deployment cannot proceed without .env.deploy configuration."
    echo ""
    exit 1
fi

# =============================================================================
# CONFIGURATION (reads from .env with fallback defaults)
# =============================================================================

# -----------------------------------------------------------------------------
# 🔑 REQUIRED SECRETS (No defaults - MUST be in .env)
# -----------------------------------------------------------------------------

# Your SSH key fingerprint from Digital Ocean
DO_SSH_KEY_FINGERPRINT="${DO_SSH_KEY_FINGERPRINT?Error: DO_SSH_KEY_FINGERPRINT must be set}"

# Path to your SSH private key file (must correspond to DO_SSH_KEY_FINGERPRINT)
DO_SSH_PRIVATE_KEY="${DO_SSH_PRIVATE_KEY?Error: DO_SSH_PRIVATE_KEY must be set}"

# Shared secret key with Laravel backend
LARAVEL_INTERNAL_KEY="${LARAVEL_INTERNAL_KEY?Error: LARAVEL_INTERNAL_KEY must be set}"

# Your GitHub repository URL
GITHUB_REPO="${GITHUB_REPO:-https://github.com/flylive302/mediasoup-socket-io-audio-broadcasting-server.git}"

# Branch to deploy from
GITHUB_BRANCH="${GITHUB_BRANCH:-master}"

# Your Laravel API URL
LARAVEL_API_URL="${LARAVEL_API_URL:-https://api.flyliveapp.com}"

# Audio server domain
AUDIO_DOMAIN="${AUDIO_DOMAIN:-audio.flyliveapp.com}"

# CORS allowed origins
CORS_ORIGINS="${CORS_ORIGINS:-https://flyliveapp.com,https://www.flyliveapp.com}"

# -----------------------------------------------------------------------------
# 🌍 DIGITAL OCEAN SETTINGS
# -----------------------------------------------------------------------------

# Region - blr1 (Bangalore), sgp1 (Singapore), nyc1/nyc3 (New York), etc.
DO_REGION="${DO_REGION:-blr1}"

# Droplet size - CPU-Optimized for mediasoup
# c-4:  ~10,000 users - $84/mo
# c-8:  ~20,000 users - $168/mo  
# c-16: ~40,000 users - $336/mo
DO_DROPLET_SIZE="${DO_DROPLET_SIZE:-c-4}"

# Droplet image (Docker on Ubuntu - slug from: doctl compute image list --public | grep docker)
DO_IMAGE="${DO_IMAGE:-docker-20-04}"

# Project name prefix
PROJECT_NAME="${PROJECT_NAME:-flylive-audio}"

# -----------------------------------------------------------------------------
# 🗄️ VALKEY SETTINGS (Redis-compatible)
# -----------------------------------------------------------------------------

# Valkey cluster size
VALKEY_SIZE="${VALKEY_SIZE:-db-s-1vcpu-1gb}"

# Valkey version
VALKEY_VERSION="${VALKEY_VERSION:-8}"

# Database number
VALKEY_DB="${VALKEY_DB:-3}"

# -----------------------------------------------------------------------------
# 🔧 ADVANCED SETTINGS
# -----------------------------------------------------------------------------

# Mediasoup RTC port range
RTC_MIN_PORT="${RTC_MIN_PORT:-10000}"
RTC_MAX_PORT="${RTC_MAX_PORT:-59999}"

# Health check settings
HEALTH_CHECK_RETRIES="${HEALTH_CHECK_RETRIES:-30}"
HEALTH_CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-10}"

# Scale-down drain timeout (seconds)
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-60}"

# Docker settings
CONTAINER_NAME="${CONTAINER_NAME:-audio-server}"
DOCKER_IMAGE="${DOCKER_IMAGE:-audio-server:latest}"

# Application port
SERVER_PORT="${SERVER_PORT:-3030}"

# -----------------------------------------------------------------------------
# Derived Variables (auto-generated from above)
# -----------------------------------------------------------------------------

VPC_NAME="${PROJECT_NAME}-vpc"
LB_NAME="${PROJECT_NAME}-lb"
FIREWALL_NAME="${PROJECT_NAME}-fw"
VALKEY_NAME="${PROJECT_NAME}-valkey"

# =============================================================================
# 📤 EXPORT ALL VARIABLES
# =============================================================================

# Required secrets
export DO_SSH_KEY_FINGERPRINT
export DO_SSH_PRIVATE_KEY
export LARAVEL_INTERNAL_KEY

# Project settings
export GITHUB_REPO
export GITHUB_BRANCH
export LARAVEL_API_URL
export AUDIO_DOMAIN
export CORS_ORIGINS

# DO settings
export DO_REGION
export DO_DROPLET_SIZE
export DO_IMAGE
export PROJECT_NAME

# Valkey settings
export VALKEY_SIZE
export VALKEY_VERSION
export VALKEY_DB

# Advanced settings
export RTC_MIN_PORT
export RTC_MAX_PORT
export HEALTH_CHECK_RETRIES
export HEALTH_CHECK_INTERVAL
export DRAIN_TIMEOUT
export CONTAINER_NAME
export DOCKER_IMAGE
export SERVER_PORT

# Derived variables
export VPC_NAME
export LB_NAME
export FIREWALL_NAME
export VALKEY_NAME

# =============================================================================
# Helper Functions
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Check if doctl is installed and authenticated
check_doctl() {
    if ! command -v doctl &> /dev/null; then
        log_error "doctl CLI is not installed. Install it first:"
        echo "  macOS: brew install doctl"
        echo "  Ubuntu: snap install doctl"
        echo "  Windows: scoop install doctl"
        exit 1
    fi
    
    if ! doctl account get &> /dev/null; then
        log_error "doctl is not authenticated. Run: doctl auth init"
        exit 1
    fi
}

# Validate SSH private key file
check_ssh_private_key() {
    local key_file="${DO_SSH_PRIVATE_KEY}"
    
    # Check if file path is provided
    if [[ -z "$key_file" ]]; then
        log_error "DO_SSH_PRIVATE_KEY is not set"
        exit 1
    fi
    
    # Check if file exists
    if [[ ! -f "$key_file" ]]; then
        log_error "SSH private key file not found: ${key_file}"
        log_info "Please set DO_SSH_PRIVATE_KEY to the path of your SSH private key file"
        exit 1
    fi
    
    # Check if file is readable
    if [[ ! -r "$key_file" ]]; then
        log_error "SSH private key file is not readable: ${key_file}"
        log_info "Check file permissions with: ls -l ${key_file}"
        exit 1
    fi
    
    # Check file permissions (should be 600 or 400 for security)
    local perms=$(stat -c "%a" "$key_file" 2>/dev/null || stat -f "%OLp" "$key_file" 2>/dev/null || echo "")
    if [[ -n "$perms" ]]; then
        # Remove leading zeros for comparison
        perms=$((10#$perms))
        if [[ $perms -ne 600 && $perms -ne 400 ]]; then
            log_error "SSH private key file has insecure permissions: ${key_file} (current: ${perms})"
            log_error "Private key files should have permissions 600 (rw-------) or 400 (r--------)"
            log_info "Fix permissions with: chmod 600 ${key_file}"
            exit 1
        fi
    fi
    
    log_success "SSH private key validated: ${key_file}"
}

# Check required environment variables
check_required_vars() {
    local missing=()
    
    if [[ -z "${DO_SSH_KEY_FINGERPRINT:-}" ]]; then
        missing+=("DO_SSH_KEY_FINGERPRINT")
    fi
    
    if [[ -z "${DO_SSH_PRIVATE_KEY:-}" ]]; then
        missing+=("DO_SSH_PRIVATE_KEY")
    fi
    
    if [[ -z "${LARAVEL_INTERNAL_KEY:-}" ]]; then
        missing+=("LARAVEL_INTERNAL_KEY")
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required environment variables in .env:"
        for var in "${missing[@]}"; do
            echo "  - $var"
        done
        echo ""
        echo "Edit your .env file and add these values."
        exit 1
    fi
    
    # Validate SSH private key file
    check_ssh_private_key
    
    log_success "All required variables are set"
}

# Get droplet IP by name
get_droplet_ip() {
    local name="$1"
    local ip
    
    # Validate input: non-empty
    if [[ -z "$name" ]]; then
        echo "get_droplet_ip: name parameter is required and cannot be empty" >&2
        return 1
    fi
    
    # Use grep -F for literal matching to prevent regex injection
    # Use -- separator to safely pass the variable
    ip=$(doctl compute droplet list --format PublicIPv4,Name --no-header | grep -F -- "$name" | awk '{print $1}')
    
    # Check if IP was found
    if [[ -z "$ip" ]]; then
        echo "get_droplet_ip: no droplet found with name '$name'" >&2
        return 1
    fi
    
    echo "$ip"
    return 0
}

# Get all audio server droplets
get_all_droplets() {
    local tag_name="${1:-${PROJECT_NAME}}"
    
    # Validate input: non-empty and reject unsafe characters
    if [[ -z "$tag_name" ]]; then
        log_error "get_all_droplets: tag name parameter is required and cannot be empty"
        return 1
    fi
    
    # Reject unsafe characters (shell metacharacters that could be used for injection)
    if [[ "$tag_name" =~ [\|\&\;\`\$\(\)\{\}\[\]\<\>\"\'\\] ]]; then
        log_error "get_all_droplets: tag name contains unsafe characters"
        return 1
    fi
    
    # Run doctl, capture stdout and stderr separately, and check for errors
    local output
    local stderr_output
    local exit_code
    local temp_stderr
    temp_stderr=$(mktemp)
    output=$(doctl compute droplet list --tag-name "$tag_name" --format Name,PublicIPv4,Status --no-header 2>"$temp_stderr")
    exit_code=$?
    stderr_output=$(cat "$temp_stderr" 2>/dev/null || echo "")
    rm -f "$temp_stderr"
    
    if [[ $exit_code -ne 0 ]]; then
        log_error "get_all_droplets: doctl command failed: $stderr_output"
        return 1
    fi
    
    echo "$output"
    return 0
}

# Get load balancer ID
get_lb_id() {
    local lb_name="${1:-${LB_NAME}}"
    
    # Validate input: non-empty
    if [[ -z "$lb_name" ]]; then
        log_error "get_lb_id: load balancer name parameter is required and cannot be empty"
        return 1
    fi
    
    # Reject unsafe characters (shell metacharacters that could be used for injection)
    if [[ "$lb_name" =~ [\|\&\;\`\$\(\)\{\}\[\]\<\>\"\'\\] ]]; then
        log_error "get_lb_id: load balancer name contains unsafe characters"
        return 1
    fi
    
    # Run doctl, capture stdout and stderr separately, and check for errors
    local output
    local stderr_output
    local doctl_output
    local exit_code
    doctl_output=$(doctl compute load-balancer list --format ID,Name --no-header 2>&1)
    exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        stderr_output=$(echo "$doctl_output" | grep -v "^$" || echo "$doctl_output")
        log_error "get_lb_id: doctl command failed: $stderr_output"
        return 1
    fi
    
    # Use grep -F for literal matching (no regex injection risk)
    output=$(echo "$doctl_output" | grep -F "$lb_name" | awk '{print $1}')
    
    # Check if output is non-empty
    if [[ -z "$output" ]]; then
        log_error "get_lb_id: load balancer '$lb_name' not found"
        return 1
    fi
    
    echo "$output"
    return 0
}

# Get VPC ID
get_vpc_id() {
    local vpc_name="${1:-${VPC_NAME}}"
    
    # Validate input: non-empty and reject unsafe characters
    if [[ -z "$vpc_name" ]]; then
        log_error "get_vpc_id: VPC name parameter is required and cannot be empty"
        return 1
    fi
    
    # Reject unsafe characters (shell metacharacters that could be used for injection)
    if [[ "$vpc_name" =~ [\|\&\;\`\$\(\)\{\}\[\]\<\>\"\'\\] ]]; then
        log_error "get_vpc_id: VPC name contains unsafe characters"
        return 1
    fi
    
    # Run doctl, capture stdout and stderr separately, and check for errors
    local output
    local stderr_output
    local doctl_output
    local exit_code
    doctl_output=$(doctl vpcs list --format ID,Name --no-header 2>&1)
    exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        stderr_output=$(echo "$doctl_output" | grep -v "^$" || echo "$doctl_output")
        log_error "get_vpc_id: doctl command failed: $stderr_output"
        return 1
    fi
    
    # Use grep -F for literal matching (no regex injection risk)
    output=$(echo "$doctl_output" | grep -F "$vpc_name" | awk '{print $1}')
    
    # Check if output is non-empty
    if [[ -z "$output" ]]; then
        log_error "get_vpc_id: VPC '$vpc_name' not found"
        return 1
    fi
    
    echo "$output"
    return 0
}

# Get firewall ID  
get_firewall_id() {
    local firewall_name="${1:-${FIREWALL_NAME}}"
    
    # Validate input: non-empty and reject unsafe characters
    if [[ -z "$firewall_name" ]]; then
        log_error "get_firewall_id: firewall name parameter is required and cannot be empty"
        return 1
    fi
    
    # Reject unsafe characters (shell metacharacters that could be used for injection)
    if [[ "$firewall_name" =~ [\|\&\;\`\$\(\)\{\}\[\]\<\>\"\'\\] ]]; then
        log_error "get_firewall_id: firewall name contains unsafe characters"
        return 1
    fi
    
    # Run doctl, capture stdout and stderr separately, and check for errors
    local output
    local stderr_output
    local doctl_output
    local exit_code
    doctl_output=$(doctl compute firewall list --format ID,Name --no-header 2>&1)
    exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        stderr_output=$(echo "$doctl_output" | grep -v "^$" || echo "$doctl_output")
        log_error "get_firewall_id: doctl command failed: $stderr_output"
        return 1
    fi
    
    # Use grep -F for literal matching (no regex injection risk)
    output=$(echo "$doctl_output" | grep -F "$firewall_name" | awk '{print $1}')
    
    # Check if output is non-empty
    if [[ -z "$output" ]]; then
        log_error "get_firewall_id: firewall '$firewall_name' not found"
        return 1
    fi
    
    echo "$output"
    return 0
}

# Get Valkey database ID by name
get_valkey_id() {
    local valkey_name="${1:-${VALKEY_NAME}}"
    local valkey_id
    valkey_id=$(doctl databases list --format ID,Name --no-header 2>/dev/null | grep -F "$valkey_name" | awk '{print $1}')
    if [[ -z "$valkey_id" ]]; then
        log_error "get_valkey_id: Valkey database '$valkey_name' not found"
        return 1
    fi
    echo "$valkey_id"
}

# Get Valkey connection info (uses ID, not name)
get_valkey_info() {
    local valkey_id
    valkey_id=$(get_valkey_id) || return 1
    doctl databases connection "$valkey_id" --format Host,Port,User,Password --no-header 2>/dev/null || echo ""
}

# Wait for droplet to be active
wait_for_droplet() {
    local droplet_id="$1"
    local max_wait=300
    local waited=0
    
    while [[ $waited -lt $max_wait ]]; do
        local status=$(doctl compute droplet get "$droplet_id" --format Status --no-header)
        if [[ "$status" == "active" ]]; then
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done
    
    return 1
}

# Health check a droplet
check_health() {
    local ip="$1"
    local retries=${HEALTH_CHECK_RETRIES}
    local interval=${HEALTH_CHECK_INTERVAL}
    
    log_info "Checking health of ${ip}..."
    
    for ((i=1; i<=retries; i++)); do
        if curl -sf "http://${ip}:${SERVER_PORT}/health" > /dev/null 2>&1; then
            log_success "Health check passed"
            return 0
        fi
        echo "  Attempt $i/$retries - waiting ${interval}s..."
        sleep "$interval"
    done
    
    log_error "Health check failed after $retries attempts"
    return 1
}

# Generate next droplet name
generate_droplet_name() {
    local max_suffix=0
    local next=1
    local max_attempts=100
    local attempts=0
    
    # Validate PROJECT_NAME is set
    if [[ -z "${PROJECT_NAME:-}" ]]; then
        log_error "generate_droplet_name: PROJECT_NAME is not set"
        return 1
    fi
    
    # List all droplets with the PROJECT_NAME tag
    local doctl_output
    local doctl_stderr
    local temp_stderr
    
    temp_stderr=$(mktemp)
    doctl_output=$(doctl compute droplet list --tag-name "${PROJECT_NAME}" --format Name --no-header 2>"$temp_stderr")
    local exit_code=$?
    doctl_stderr=$(cat "$temp_stderr" 2>/dev/null || echo "")
    rm -f "$temp_stderr"
    
    if [[ $exit_code -ne 0 ]]; then
        log_error "generate_droplet_name: failed to list droplets: $doctl_stderr"
        return 1
    fi
    
    # Filter names matching the exact pattern and extract numeric suffixes
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        
        # Match the exact pattern: PROJECT_NAME-NN (where NN is exactly 2 digits)
        if [[ "$name" =~ ^${PROJECT_NAME}-([0-9]{2})$ ]]; then
            local suffix="${BASH_REMATCH[1]}"
            # Remove leading zero if present (bash arithmetic treats 01 as 1, but we want numeric comparison)
            local suffix_num=$((10#$suffix))
            
            if [[ $suffix_num -gt $max_suffix ]]; then
                max_suffix=$suffix_num
            fi
        fi
    done <<< "$doctl_output"
    
    # Compute next suffix: max + 1, or 1 if none found
    if [[ $max_suffix -gt 0 ]]; then
        next=$((max_suffix + 1))
    else
        next=1
    fi
    
    # Validate next suffix is within reasonable bounds (00-99)
    if [[ $next -lt 1 ]] || [[ $next -gt 99 ]]; then
        log_error "generate_droplet_name: computed suffix $next is out of valid range (01-99)"
        return 1
    fi
    
    # Attempt to find an available name with bounded retries
    while [[ $attempts -lt $max_attempts ]]; do
        local candidate=$(printf "%s-%02d" "${PROJECT_NAME}" "$next")
        
        # Check if this candidate name already exists
        local exists
        temp_stderr=$(mktemp)
        doctl_output=$(doctl compute droplet list --tag-name "${PROJECT_NAME}" --format Name --no-header 2>"$temp_stderr")
        local doctl_exit_code=$?
        doctl_stderr=$(cat "$temp_stderr" 2>/dev/null || echo "")
        rm -f "$temp_stderr"
        
        if [[ $doctl_exit_code -ne 0 ]]; then
            log_error "generate_droplet_name: failed to check droplet existence: $doctl_stderr"
            return 1
        fi
        
        exists=$(echo "$doctl_output" | grep -Fx -- "$candidate" || echo "")
        
        # If candidate doesn't exist, we found our name
        if [[ -z "$exists" ]]; then
            echo "$candidate"
            return 0
        fi
        
        # Candidate exists, try next number
        next=$((next + 1))
        attempts=$((attempts + 1))
        
        # Validate we're still in range
        if [[ $next -gt 99 ]]; then
            log_error "generate_droplet_name: exhausted all valid suffix numbers (01-99)"
            return 1
        fi
    done
    
    # Exceeded max attempts
    log_error "generate_droplet_name: exceeded maximum attempts ($max_attempts) to find available droplet name"
    return 1
}

# Export all functions for subshells
export -f log_info log_success log_warn log_error
export -f check_doctl check_required_vars check_ssh_private_key
export -f get_droplet_ip get_all_droplets get_lb_id get_vpc_id get_firewall_id get_valkey_id get_valkey_info
export -f wait_for_droplet check_health generate_droplet_name

