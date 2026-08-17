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

if [[ $violations -gt 0 ]]; then
  echo "MSAB architecture checks failed with $violations violation group(s)."
  exit 1
fi

echo "MSAB architecture checks passed."
