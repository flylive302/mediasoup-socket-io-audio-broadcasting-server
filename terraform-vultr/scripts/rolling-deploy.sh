#!/usr/bin/env bash
# =============================================================================
# Rolling, drain-gated, one-instance-at-a-time app deploy for the Vultr fleet
# (slice 08 / issue H). Mirrors the AWS ASG instance-refresh, but Terraform owns
# the vultr_instance resources directly here (no ASG layer), so a deploy = a
# scoped instance replacement, NOT an infra-diff apply. Infra changes
# (networking/Valkey/LB/scaling) go through the separate manual-dispatch infra
# workflow — never this script.
#
# Pipeline per instance (GATE→EXECUTE→REACT, halt-on-failure):
#   1. DRAIN   POST /admin/drain → poll /admin/status until drained (rooms=0 or
#              the app's own drain timeout). Health flips to 503 so the LB stops
#              routing NEW connections while live rooms finish.
#   2. REPLACE roll_one_instance() — the ONE mechanism-specific line (see below).
#   3. GATE    wait for the replaced instance's /health=200 before touching the
#              next. Any failure (drain stall, replace error, health timeout)
#              exits non-zero under `set -e` → the roll HALTS with the rest of the
#              fleet untouched (AC5).
#
# The reserved IP is a separate Terraform resource that re-attaches to the new
# instance across a replace (proven slice D/E), so an instance's public IP is
# STABLE across its own replacement — we read the IP map once, up front.
#
# LB-attachment mechanism (the old A-vs-C open question) — RESOLVED, validated
# live 2026-07-09: the Vultr LB attaches backends by INSTANCE ID, so every
# replace orphans the LB (fleet-wide 503 at the LB even with healthy instances)
# until the new id is re-attached. reattach_lb() runs after every replace for
# exactly this reason — via the Vultr API, NOT terraform (see its warning).
#
# Vultr fee-cap billing lag (validated live 2026-07-08/09): right after a
# destroy, the destroyed instance still counts against the account's monthly
# fee cap for a few minutes, so the create half of a replace can be rejected
# ("maximum monthly fee limit"). roll_one_instance() retries the create-only
# apply (the destroy has already happened, so -replace must be dropped).
# =============================================================================
set -euo pipefail

# --- Required env ---
: "${IMAGE_TAG:?IMAGE_TAG is required (ghcr tag, e.g. sha-1a2b3c4d)}"
: "${LARAVEL_INTERNAL_KEY:?LARAVEL_INTERNAL_KEY is required (X-Internal-Key for /admin/*)}"

# --- Optional env ---
APP_PORT="${APP_PORT:-3030}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-600}"      # seconds to let rooms close before force-drain
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-480}"    # seconds to wait for a fresh instance's /health=200 (full cloud-init boot)
POLL_INTERVAL="${POLL_INTERVAL:-10}"
TFVARS_FILE="${TFVARS_FILE:-}"             # local runs pass a *.tfvars; CI passes TF_VAR_* env instead
DRY_RUN="${DRY_RUN:-}"                      # any non-empty value = print actions, skip drain/replace

TF_VARFILE_ARG=()
[[ -n "${TFVARS_FILE}" ]] && TF_VARFILE_ARG=(-var-file="${TFVARS_FILE}")

log() { printf '%s\n' "$*" >&2; }

# ─── DRAIN ───────────────────────────────────────────────────────────────────
drain_instance() {
  local ip="$1"
  if [[ -n "${DRY_RUN}" ]]; then log "   DRY_RUN drain ${ip}"; return 0; fi

  log "   ⇢ draining ${ip} (rooms close, ≤${DRAIN_TIMEOUT}s)"
  if ! curl -fsS -X POST "http://${ip}:${APP_PORT}/admin/drain?timeout=${DRAIN_TIMEOUT}" \
    -H "X-Internal-Key: ${LARAVEL_INTERNAL_KEY}" >/dev/null; then
    # Unreachable instance — the usual cause is a previously halted roll that
    # destroyed it (fee-cap rejection). Nothing to drain; the replace step
    # recreates it, so a plain workflow re-run recovers the fleet.
    log "   ⇢ ${ip} unreachable — skipping drain (destroyed/dead instance; replace recreates it)"
    return 0
  fi

  local elapsed=0 deadline=$((DRAIN_TIMEOUT + 60)) status
  while (( elapsed < deadline )); do
    status=$(curl -fsS "http://${ip}:${APP_PORT}/admin/status" \
      -H "X-Internal-Key: ${LARAVEL_INTERNAL_KEY}" 2>/dev/null || echo '{}')
    if [[ "$(jq -r '.drained // false' <<<"$status")" == "true" ]]; then
      log "   ⇢ drained (rooms=$(jq -r '.rooms // "?"' <<<"$status"))"
      return 0
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  log "   ✖ drain did not complete for ${ip} within ${deadline}s"
  return 1
}

# ─── REPLACE ─────────────────────────────────────────────────────────────────
# The pinned image_tag change forces a vultr_instance replacement. `-target`
# confines the plan to just this index; siblings stay out of the graph (and
# un-dirtied) until their turn. If the create half is rejected (Vultr fee-cap
# billing lag — see header), the instance is already destroyed and gone from
# state, so the retries are create-only targeted applies WITHOUT -replace
# (-replace on a state-absent address errors instead of creating).
REPLACE_RETRIES="${REPLACE_RETRIES:-3}"
REPLACE_RETRY_DELAY="${REPLACE_RETRY_DELAY:-120}"

roll_one_instance() {
  local addr="$1"
  if [[ -n "${DRY_RUN}" ]]; then log "   DRY_RUN terraform apply -replace=${addr} -var image_tag=${IMAGE_TAG}"; return 0; fi
  if terraform apply -input=false -auto-approve \
    -target="${addr}" -replace="${addr}" \
    -var "image_tag=${IMAGE_TAG}" "${TF_VARFILE_ARG[@]}"; then
    return 0
  fi

  local attempt
  for (( attempt = 1; attempt <= REPLACE_RETRIES; attempt++ )); do
    log "   ⇢ replace failed (fee-cap billing lag is the usual cause) — create-only retry ${attempt}/${REPLACE_RETRIES} in ${REPLACE_RETRY_DELAY}s"
    sleep "${REPLACE_RETRY_DELAY}"
    if terraform apply -input=false -auto-approve \
      -target="${addr}" \
      -var "image_tag=${IMAGE_TAG}" "${TF_VARFILE_ARG[@]}"; then
      return 0
    fi
  done
  log "   ✖ replace of ${addr} failed after ${REPLACE_RETRIES} retries — halting roll"
  return 1
}

# ─── LB RE-ATTACH (runs after every replace) ─────────────────────────────────
# The Vultr LB references backends by instance id; the replace above changed the
# id, so without this the LB serves 503 fleet-wide even though every instance is
# healthy (observed live 2026-07-09).
#
# ⚠️ MUST go through the Vultr API, NEVER `terraform apply -target=<LB>`: the
# LB's attached_instances depends on EVERY instance, so targeting the LB pulls
# all siblings into the graph — and any sibling whose user_data still carries
# the OLD image tag gets REPLACED in the same apply, destroying the one healthy
# instance mid-roll (observed live 2026-07-09, run #3: the LB target destroyed
# the serving sibling and its re-create hit the fee cap → full outage).
# Attaching by API leaves no lasting drift: attached_instances converges to the
# same live ids once the roll finishes.
reattach_lb() {
  local region="$1"
  if [[ -n "${DRY_RUN}" ]]; then log "   DRY_RUN Vultr-API reattach LB (${region}) to live fleet ids"; return 0; fi
  : "${VULTR_API_KEY:?VULTR_API_KEY is required (LB re-attach)}"

  local lb_ip lb_id region_ips live_ids
  lb_ip=$(terraform output -json region_lb_ipv4 | jq -r --arg r "$region" '.[$r]')
  lb_id=$(curl -fsS -H "Authorization: Bearer ${VULTR_API_KEY}" \
    "https://api.vultr.com/v2/load-balancers?per_page=500" \
    | jq -r --arg ip "$lb_ip" '.load_balancers[] | select(.ipv4 == $ip) | .id')
  [[ -n "$lb_id" && "$lb_id" != "null" ]] || { log "   ✖ no LB found with ipv4 ${lb_ip}"; return 1; }

  # Live instance ids whose main_ip is one of this region's reserved IPs — the
  # just-created replacement is present immediately; the LB's own health check
  # gates it out of rotation until it actually boots.
  region_ips=$(terraform output -json region_public_ips | jq --arg r "$region" '.[$r]')
  live_ids=$(curl -fsS -H "Authorization: Bearer ${VULTR_API_KEY}" \
    "https://api.vultr.com/v2/instances?per_page=500" \
    | jq -c --argjson ips "$region_ips" '[.instances[] | select(.main_ip as $m | $ips | index($m)) | .id]')
  [[ "$live_ids" != "[]" ]] || { log "   ✖ no live instances match region ${region} reserved IPs"; return 1; }

  log "   ⇢ re-attaching LB ${lb_id} → ${live_ids}"
  curl -fsS -X PATCH -H "Authorization: Bearer ${VULTR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"instances\": ${live_ids}}" \
    "https://api.vultr.com/v2/load-balancers/${lb_id}" >/dev/null
}

# ─── GATE: new instance healthy before we move on ────────────────────────────
wait_health() {
  local ip="$1"
  if [[ -n "${DRY_RUN}" ]]; then log "   DRY_RUN wait /health ${ip}"; return 0; fi

  log "   ⇢ waiting for ${ip}/health=200 (≤${HEALTH_TIMEOUT}s — fresh instance runs full cloud-init: docker install + image pull, several minutes; not a hang)"
  local elapsed=0 code
  while (( elapsed < HEALTH_TIMEOUT )); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://${ip}:${APP_PORT}/health" 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && { log "   ✅ ${ip} healthy"; return 0; }
    sleep 15; elapsed=$((elapsed + 15))
  done
  log "   ✖ ${ip} did not return /health=200 within ${HEALTH_TIMEOUT}s — halting roll"
  return 1
}

# ─── Orchestration ───────────────────────────────────────────────────────────
main() {
  log "▶ Rolling deploy → image tag ${IMAGE_TAG}${DRY_RUN:+ (DRY_RUN)}"

  # region -> [ip, ...] (reserved IPs, stable across each instance's own replace)
  local ips_json regions region count i ip addr
  ips_json="$(terraform output -json region_public_ips)"
  regions=$(jq -r 'keys[]' <<<"$ips_json")

  for region in $regions; do
    count=$(jq -r --arg r "$region" '.[$r] | length' <<<"$ips_json")
    log "═══ region ${region}: ${count} instance(s) ═══"
    for (( i = 0; i < count; i++ )); do
      ip=$(jq -r --arg r "$region" --argjson i "$i" '.[$r][$i]' <<<"$ips_json")
      addr="module.compute[\"${region}\"].vultr_instance.main[${i}]"
      log "── ${region}[${i}]  ${ip}  →  ${addr}"
      drain_instance "$ip"       # halts roll on stall
      roll_one_instance "$addr"  # halts roll on terraform error (after create-only retries)
      reattach_lb "$region"      # LB binds instance ids — re-attach the new id or the LB 503s
      wait_health "$ip"          # halts roll if the new instance never goes healthy
    done
  done
  log "✅ Rolling deploy complete — whole fleet on ${IMAGE_TAG}."
}

main "$@"
