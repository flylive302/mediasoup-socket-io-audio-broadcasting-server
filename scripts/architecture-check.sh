#!/usr/bin/env bash
set -euo pipefail

echo "Running MSAB architecture checks..."

violations=0

check() {
  local message="$1"
  local pattern="$2"
  local target="$3"
  if grep -R -nE "$pattern" "$target" --include='*.ts' 2>/dev/null >/tmp/arch_check_msab.out; then
    echo "FAIL: $message"
    cat /tmp/arch_check_msab.out
    violations=$((violations + 1))
  fi
}

# Empty catch blocks hide REACT failures — log instead.
check "Silent catch blocks are not allowed" 'catch\s*\([^)]*\)\s*\{\s*\}' src

# --- Cutover invariant: the public audio hostname stays Cloudflare-proxied ----
# aws-production ticket 28. cloudflare_dns_record.audio is the cutover itself,
# and its proxy mode is a safety decision that reads like an oversight:
# a DNS-only record changes the PUBLIC answer, so resolvers holding the old one
# keep dialling Cloudflare's edge for a hostname it no longer proxies — a hard
# failure for up to the pinned 300s TTL, which cannot be shortened in advance.
# Proxied changes only the ORIGIN, so the flip AND the rollback are immediate.
# ttl = 1 is mandatory: the Cloudflare API rejects any other TTL when proxied.
# Rationale in full: modules/region/main.tf, docs/runbooks/msab-aws-cutover.md §4a.
#
# This lives here rather than in `terraform test` because a ./modules/region
# scoped tftest re-types the suite's mock providers and breaks unrelated files
# (see tests/plan_assertions.tftest.hcl's note on module-scoped runs).
audio_dns_block=$(awk '/resource "cloudflare_dns_record" "audio"/,/^}/' \
  terraform/modules/region/main.tf 2>/dev/null || true)

if [[ -z "$audio_dns_block" ]]; then
  echo "FAIL: cloudflare_dns_record.audio not found in terraform/modules/region/main.tf"
  echo "      If it was renamed or moved, update this check — do not delete it."
  violations=$((violations + 1))
elif ! grep -qE '^\s*proxied\s*=\s*true\s*$' <<<"$audio_dns_block" \
  || ! grep -qE '^\s*ttl\s*=\s*1\s*$' <<<"$audio_dns_block"; then
  echo "FAIL: the audio hostname's DNS record must stay proxied = true with ttl = 1"
  echo "      DNS-only buys an un-shortenable ~300s outage window at the cutover."
  echo "      See terraform/modules/region/main.tf and docs/runbooks/msab-aws-cutover.md §4a."
  echo "$audio_dns_block"
  violations=$((violations + 1))
fi

# --- Cutover invariant: Capacitor WebView origins stay in the CORS allowlist ---
# aws-production ticket 28. MSAB's auth middleware (F-63, src/auth/middleware.ts)
# refuses the socket handshake server-side for any origin not in CORS_ORIGINS.
# Every mobile client is the Capacitor shell: Android WebView reports
# Origin: https://localhost, iOS reports capacitor://localhost. The AWS fleet
# shipped with only the web origins, which a live probe (2026-08-18) showed
# would have refused every mobile client at the flip while web kept working.
# This guards the variables.tf DEFAULT — the fallback if a truncated
# TF_VARS_PROD paste ever drops the cors_origins line from prod.tfvars.
cors_default=$(awk '/variable "cors_origins"/,/^}/' terraform/variables.tf 2>/dev/null \
  | grep -E '^\s*default\s*=' || true)

if [[ -z "$cors_default" ]]; then
  echo "FAIL: cors_origins default not found in terraform/variables.tf"
  echo "      If the variable was renamed or moved, update this check — do not delete it."
  violations=$((violations + 1))
elif ! grep -q 'https://localhost' <<<"$cors_default" \
  || ! grep -q 'capacitor://localhost' <<<"$cors_default"; then
  echo "FAIL: cors_origins default must include the Capacitor WebView origins"
  echo "      (https://localhost for Android, capacitor://localhost for iOS)."
  echo "      Without them MSAB refuses every mobile client's socket handshake (F-63)."
  echo "$cors_default"
  violations=$((violations + 1))
fi

if [[ $violations -gt 0 ]]; then
  echo "MSAB architecture checks failed with $violations violation group(s)."
  exit 1
fi

echo "MSAB architecture checks passed."
