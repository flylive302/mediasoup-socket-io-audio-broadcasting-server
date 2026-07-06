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
# ⚠️ roll_one_instance() body is UNVALIDATED — it depends on the unresolved
# A-vs-C LB-attachment decision (see docs/issues/vultr-migration/PENDING-vultr-verification.md
# § "Rolling-deploy LB-attachment mechanism"). Everything else in this script is
# mechanism-independent and reviewable now. Do NOT trust the replace step against
# a live fleet until that decision is made and tested.
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
  curl -fsS -X POST "http://${ip}:${APP_PORT}/admin/drain?timeout=${DRAIN_TIMEOUT}" \
    -H "X-Internal-Key: ${LARAVEL_INTERNAL_KEY}" >/dev/null

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

# ─── REPLACE (mechanism seam — SINGLE unvalidated line) ──────────────────────
# The pinned image_tag change forces a vultr_instance replacement; the open
# A-vs-C decision only changes HOW the LB re-attaches the new id without churning
# the live sibling. Until resolved, this is the naive form and is guarded by the
# PENDING note above. `-target` confines the plan to just this index; siblings
# stay out of the graph (and un-dirtied) until their turn.
roll_one_instance() {
  local addr="$1"
  if [[ -n "${DRY_RUN}" ]]; then log "   DRY_RUN terraform apply -replace=${addr} -var image_tag=${IMAGE_TAG}"; return 0; fi
  terraform apply -input=false -auto-approve \
    -target="${addr}" -replace="${addr}" \
    -var "image_tag=${IMAGE_TAG}" "${TF_VARFILE_ARG[@]}"
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
      roll_one_instance "$addr"  # halts roll on terraform error
      wait_health "$ip"          # halts roll if the new instance never goes healthy
    done
  done
  log "✅ Rolling deploy complete — whole fleet on ${IMAGE_TAG}."
}

main "$@"
