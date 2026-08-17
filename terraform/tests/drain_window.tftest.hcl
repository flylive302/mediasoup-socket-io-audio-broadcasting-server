# =============================================================================
# ticket 18 — drain window, warmup budget, and computed container memory
# =============================================================================
# These runs are MODULE-SCOPED (`module { source = "./modules/autoscaling" }`).
# A module-scoped run re-types the mock providers for the whole suite, so it
# cannot share a file with the root-module runs in plan_assertions.tftest.hcl —
# same reason log_retention / ssm_kms / ssl_validation live in their own files.
#
# ⚠️ After adding this file, re-run `terraform init -backend=false` before
# `terraform test`, or Terraform reports "Module not installed" and then a
# misleading provider-type-mismatch cascade.
#
# What is under test: the ticket's core defect was FOUR drain-related numbers
# that had to agree and didn't (hook 150s, script ceiling 900s, app-facing ask
# 840s, app's real ceiling 120s). They are now all derived from ONE variable,
# var.app_drain_ceiling_seconds. The assertions below pin the ORDERING those
# derived values must satisfy — not their current literal values — so the
# ordering survives any future re-tuning of the ceiling.
# =============================================================================

mock_provider "aws" {}

variables {
  # Required (no-default) module inputs — dummies, never applied.
  region                 = "ap-south-1"
  project_name           = "flylive-audio"
  environment            = "production"
  ssh_public_key_path    = "./tests/fixtures/id_ed25519.pub"
  instance_profile_name  = "mock-profile"
  msab_security_group_id = "sg-mock"
  public_subnet_ids      = ["subnet-mock-a", "subnet-mock-b"]
  target_group_arn       = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:targetgroup/mock/abc"
  ecr_repo_url           = "111111111111.dkr.ecr.ap-south-1.amazonaws.com/flylive-audio/msab"
  redis_host             = "mock-redis"
  redis_cache_host       = "mock-redis-cache"
  image_tag              = "sha-deadbeef"
}

# -----------------------------------------------------------------------------
# The drain ordering invariant (AC #3). Asserted against the RENDERED user-data,
# not just against locals — the script is what actually runs on the instance, so
# a local that never reaches the script would still be a live bug.
# -----------------------------------------------------------------------------
run "drain_window_values_cannot_diverge" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  # The app's ceiling mirrors src/index.ts DRAIN_CEILING_MS (120_000 ms).
  # Everything else is derived from it.
  assert {
    condition     = var.app_drain_ceiling_seconds == 120
    error_message = "app_drain_ceiling_seconds must mirror MSAB's own DRAIN_CEILING_MS (src/index.ts = 120_000 ms). Change both together or not at all."
  }

  # 1. The terminate hook is exactly ceiling + margin — never a free literal.
  assert {
    condition     = aws_autoscaling_lifecycle_hook.terminating.heartbeat_timeout == var.app_drain_ceiling_seconds + var.drain_hook_margin_seconds
    error_message = "Terminate-hook heartbeat must be derived as app_drain_ceiling_seconds + drain_hook_margin_seconds"
  }

  # 2. The script ASKS the app for at least the app's own ceiling. The old
  #    `MAX_DRAIN_WAIT - 60` offset, carried onto the 150s window, asked for 90s
  #    — below the 120s MSAB needs. That regression fails here.
  assert {
    condition     = strcontains(output.user_data_rendered, "\nDRAIN_REQUEST=${var.app_drain_ceiling_seconds}\n")
    error_message = "The drain script must ask MSAB for at least its own drain ceiling — never a smaller derived value"
  }

  # Matches the arithmetic form, not prose — the script's own comment explains the
  # retired offset and must not trip this.
  assert {
    condition     = !strcontains(output.user_data_rendered, "$((MAX_DRAIN_WAIT - 60))")
    error_message = "The retired `$((MAX_DRAIN_WAIT - 60))` offset must not return — it was tuned against a 900s window and silently under-asks on a 150s one"
  }

  # 3. The script's own poll ceiling gives the app its full ceiling plus one tick.
  assert {
    condition     = strcontains(output.user_data_rendered, "\nMAX_DRAIN_WAIT=${var.app_drain_ceiling_seconds + var.drain_poll_interval_seconds}\n")
    error_message = "The drain script's poll ceiling must be app_drain_ceiling_seconds + one poll interval"
  }

  # 4. …and STRICTLY LESS than the hook heartbeat, so complete-lifecycle-action
  #    always lands inside the window AWS is holding open. The script never sends
  #    a lifecycle heartbeat, so a tie would race hook expiry with no recovery.
  assert {
    condition     = var.app_drain_ceiling_seconds + var.drain_poll_interval_seconds < aws_autoscaling_lifecycle_hook.terminating.heartbeat_timeout
    error_message = "The drain script's poll ceiling must be STRICTLY below the terminate-hook heartbeat — a tie races complete-lifecycle-action against hook expiry"
  }

  # 5. No stale 900s literal anywhere in the rendered script.
  assert {
    condition     = !strcontains(output.user_data_rendered, "\nMAX_DRAIN_WAIT=900\n")
    error_message = "The 900s MAX_DRAIN_WAIT literal must never come back — AWS closes the window at 150s"
  }

  # 6. Detection lag is rendered too, not a literal. The hook's clock starts when AWS
  #    transitions the instance, not when the monitor notices, so this interval is charged
  #    against the same window — and the margin is validated to exceed it.
  assert {
    condition     = strcontains(output.user_data_rendered, "\nPOLL_INTERVAL=${var.lifecycle_poll_interval_seconds}\n")
    error_message = "The lifecycle detection poll interval must be rendered from a variable — it is part of the drain budget, not free"
  }
}

# -----------------------------------------------------------------------------
# The margin must cover the detection lag + one drain tick, not merely be "big
# enough looking". The retired `>= 10` floor would have accepted 12 here, while
# the detection lag alone can be 10 — leaving 2s for everything else.
# -----------------------------------------------------------------------------
run "drain_hook_margin_must_exceed_detection_lag_plus_a_tick" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    drain_hook_margin_seconds       = 12
    lifecycle_poll_interval_seconds = 10
    drain_poll_interval_seconds     = 5
  }

  expect_failures = [
    var.drain_hook_margin_seconds,
  ]
}

# -----------------------------------------------------------------------------
# A host reserve that eats the whole instance must fail at plan. `--memory=0m` is
# worse than no cap: Docker may read it as "unlimited", silently removing the
# limit rather than failing loudly.
# -----------------------------------------------------------------------------
run "host_reserve_cannot_starve_the_container" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    instance_type    = "c7i.large" # 4096 MiB
    host_reserve_gib = 4           # would leave 0
  }

  expect_failures = [
    var.host_reserve_gib,
  ]
}

# -----------------------------------------------------------------------------
# The invariant must hold for a DIFFERENT ceiling too — otherwise the assertions
# above only prove today's numbers, not that the derivation is real.
# -----------------------------------------------------------------------------
run "drain_window_still_ordered_at_a_different_ceiling" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    app_drain_ceiling_seconds   = 200
    drain_hook_margin_seconds   = 30
    drain_poll_interval_seconds = 5
  }

  assert {
    condition     = aws_autoscaling_lifecycle_hook.terminating.heartbeat_timeout == 230
    error_message = "Hook heartbeat must track a changed app ceiling (200 + 30 = 230)"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nMAX_DRAIN_WAIT=205\n")
    error_message = "Script poll ceiling must track a changed app ceiling (200 + 5 = 205)"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nDRAIN_REQUEST=200\n")
    error_message = "App-facing drain request must track a changed app ceiling"
  }

  assert {
    condition     = 205 < aws_autoscaling_lifecycle_hook.terminating.heartbeat_timeout
    error_message = "Ordering must survive a changed ceiling: poll ceiling < hook heartbeat"
  }
}

# -----------------------------------------------------------------------------
# A margin smaller than one poll interval would put the script's give-up point
# at or beyond hook expiry. The variable's own validation must reject it.
# -----------------------------------------------------------------------------
run "drain_hook_margin_rejects_too_small_a_value" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    drain_hook_margin_seconds = 3
  }

  expect_failures = [
    var.drain_hook_margin_seconds,
  ]
}

# -----------------------------------------------------------------------------
# AC #4 — warmup is derived from ticket 17's measured container cold boot plus
# the itemised user-data bootstrap cost, and the SAME number gates the ELB
# health-check grace period. Two literals here is exactly the class of drift the
# ticket exists to remove.
# -----------------------------------------------------------------------------
run "warmup_and_grace_derive_from_one_budget" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = var.container_warmup_seconds == 90
    error_message = "container_warmup_seconds must carry ticket 17's measured cold-boot budget (90s container-level)"
  }

  assert {
    condition     = aws_autoscaling_group.msab.health_check_grace_period == var.container_warmup_seconds + var.bootstrap_overhead_seconds
    error_message = "health_check_grace_period must be the derived cold-boot budget, not an independent literal"
  }

  assert {
    condition     = aws_autoscaling_group.msab.instance_refresh[0].preferences[0].instance_warmup == tostring(var.container_warmup_seconds + var.bootstrap_overhead_seconds)
    error_message = "instance_refresh warmup must be the SAME derived budget as health_check_grace_period"
  }
}

# -----------------------------------------------------------------------------
# AC #6 — the container memory cap is computed from the instance type's RAM and
# a stated host reserve. On c7i.xlarge that reproduces the proven production
# runtime's 6g exactly (8192 MiB − 2 GiB = 6144 MiB), and --memory-swap must
# equal --memory (swap on a mediasoup worker is audible stutter).
# -----------------------------------------------------------------------------
run "container_memory_is_computed_from_instance_ram" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "--memory=6144m")
    error_message = "c7i.xlarge (8192 MiB) minus the 2 GiB host reserve must render --memory=6144m — the same cap the proven production runtime uses"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "--memory-swap=6144m")
    error_message = "--memory-swap must equal --memory (no swap headroom for a mediasoup worker)"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "--memory=7g")
    error_message = "The hardcoded 7g memory literal must never come back"
  }
}

run "container_memory_tracks_a_larger_instance_type" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    instance_type = "c7i.2xlarge"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "--memory=14336m")
    error_message = "c7i.2xlarge (16384 MiB) minus the 2 GiB host reserve must render --memory=14336m — proving the cap is computed, not restated"
  }
}

run "unknown_instance_type_is_rejected" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    instance_type = "m5.metal.does-not-exist"
  }

  expect_failures = [
    var.instance_type,
  ]
}

# -----------------------------------------------------------------------------
# AC #1 — the rendered container run must stay flag-for-flag identical to the
# proven production runtime (docs/runbooks/msab-by-hand-deploy.md): host
# networking, restart policy, json-file logging with the same rotation, two
# env-files and NO secrets on the command line.
# -----------------------------------------------------------------------------
run "container_run_matches_the_proven_runtime" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = alltrue([for f in ["--name msab", "--restart unless-stopped", "--network host", "--log-driver=json-file", "--log-opt max-size=100m", "--log-opt max-file=5", "--env-file /opt/msab/.env", "--env-file /opt/msab/.env.secrets"] : strcontains(output.user_data_rendered, f)])
    error_message = "The rendered docker run must match the proven production runtime flag-for-flag (docs/runbooks/msab-by-hand-deploy.md)"
  }

  # Secrets ride the 0600 env-file, never the command line — the proven runtime
  # passes no -e flags either.
  assert {
    condition     = !strcontains(output.user_data_rendered, "-e \"JWT_SECRET=")
    error_message = "Secrets must not be passed as docker -e flags — they belong in the 0600 env-file, as on the live box"
  }
}

# -----------------------------------------------------------------------------
# Env-file safety net. Moving the secrets from `docker run -e` to a --env-file
# swapped a shell parser for one that has no quote handling and reads a value to
# end of line. The rendered script must therefore strip CR at fetch time and
# refuse a secret containing a newline — otherwise the failure surfaces as
# "instance won't boot" during the first apply.
# -----------------------------------------------------------------------------
run "rendered_script_sanitizes_secrets_for_the_env_file" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "| tr -d '\\r'")
    error_message = "fetch_ssm must strip CR — a CRLF-pasted SSM value would otherwise land inside the env-file value"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "contains a newline")
    error_message = "The bootstrap must reject a secret containing a newline before writing the env-file, not fail opaquely at docker run"
  }
}

# -----------------------------------------------------------------------------
# JWT rotation overlap (aws-production/28). MSAB's verifier builds its candidate
# list from JWT_SECRET + JWT_SECRET_PREVIOUS (src/auth/jwtValidator.ts) — but the
# AWS bootstrap only ever wrote JWT_SECRET, so a rotation would have thrown every
# listener off audio for the length of an instance refresh.
#
# The overlap value must reach the env-file, must be sanitized like every other
# secret, and must NOT join the critical-secrets gate: outside a rotation the SSM
# parameter does not exist, fetch_ssm returns "", and an empty value there is the
# normal steady state rather than a reason to ABANDON the launch hook.
# -----------------------------------------------------------------------------
run "rotation_overlap_reaches_the_env_file_without_gating_boot" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "SECRET_JWT_PREVIOUS=$(fetch_ssm \"jwt-secret-previous\")")
    error_message = "The bootstrap must fetch the jwt-secret-previous parameter — without it the AWS fleet has no JWT rotation path"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "JWT_SECRET_PREVIOUS=$SECRET_JWT_PREVIOUS")
    error_message = "JWT_SECRET_PREVIOUS must be written to the secrets env-file — jwtValidator.ts reads it from there"
  }

  # The newline-rejection loop covers it; the empty-value FATAL gate must not.
  assert {
    condition     = strcontains(output.user_data_rendered, "SECRET_JWT SECRET_JWT_PREVIOUS SECRET_INTERNAL_KEY")
    error_message = "SECRET_JWT_PREVIOUS must be in the newline-rejection loop — a CRLF-pasted overlap value would corrupt the env-file exactly like any other secret"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "\"JWT_PREVIOUS:$SECRET_JWT_PREVIOUS\"")
    error_message = "SECRET_JWT_PREVIOUS must NOT join the critical-secrets gate — empty is its steady state, and gating on it would ABANDON every launch outside a rotation"
  }
}

# =============================================================================
# ticket 19 — bootstrap fails closed on any architecture, stable identity
# =============================================================================

# -----------------------------------------------------------------------------
# AC #2/#3 — everything an instance needs BEFORE traffic (CW agent, drain
# service + liveness assert, launch-hook completion) renders AHEAD of
# `docker run`, and any failure fails closed: EXIT trap ABANDONs the launch
# hook, and the hook's own default is ABANDON for failures the trap can't reach.
# Ordering is asserted on the prefix of the rendered script before the docker
# run — prose alone cannot drift this back.
# -----------------------------------------------------------------------------
run "bootstrap_fails_closed_before_traffic" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = aws_autoscaling_lifecycle_hook.launching.default_result == "ABANDON"
    error_message = "Launch hook default_result must be ABANDON — a bootstrap that dies before completing the hook must terminate the instance, not drift InService"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "trap on_exit EXIT")
    error_message = "user-data must install the fail-closed EXIT trap before doing any work"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "--lifecycle-action-result \"ABANDON\"")
    error_message = "The EXIT trap must ABANDON the launch hook on failure — fail closed, not fail open"
  }

  # Ordering: the prefix of the script BEFORE `docker run -d` must already contain…
  assert {
    condition     = strcontains(split("docker run -d", output.user_data_rendered)[0], "systemctl start msab-lifecycle")
    error_message = "The drain service must be installed and started BEFORE the container starts — the ARM defect was exactly this order reversed"
  }

  assert {
    condition     = strcontains(split("docker run -d", output.user_data_rendered)[0], "systemctl is-active --quiet msab-lifecycle")
    error_message = "The drain monitor must be PROVEN active (systemctl is-active) before the container starts, not assumed"
  }

  assert {
    condition     = strcontains(split("docker run -d", output.user_data_rendered)[0], "amazon-cloudwatch-agent-ctl")
    error_message = "The CloudWatch agent must be installed and started BEFORE the container starts"
  }

  # aws-production 02 REVERSED the third ticket-19 ordering: hook completion is no
  # longer before the container — it is the LAST act, after the /health gate. The
  # positive assertion lives in launch_hook_completes_only_after_health_gate below;
  # here we pin that the CONTINUE block never creeps back above `docker run`.
  # ("Completing launch lifecycle hook" is the block's marker — the hook NAME also
  # appears earlier, in the EXIT trap's ABANDON, which legitimately stays on top.)
  assert {
    condition     = !strcontains(split("docker run -d", output.user_data_rendered)[0], "Completing launch lifecycle hook")
    error_message = "The launch-hook CONTINUE block must NOT run before `docker run` — a hook completed early makes the trap's ABANDON a no-op and leaves an InService instance serving nothing (aws-production 02, F4)"
  }

  # AC #1 — no hardcoded-architecture monitoring agent package.
  assert {
    condition     = strcontains(output.user_data_rendered, "dpkg --print-architecture")
    error_message = "The CW agent install must derive its architecture (dpkg --print-architecture), never hardcode one"
  }

  assert {
    condition     = !strcontains(output.user_data_rendered, "ubuntu/amd64/latest/amazon-cloudwatch-agent.deb")
    error_message = "The hardcoded amd64 CW-agent .deb URL must never come back — it is what killed the ARM bootstrap after traffic"
  }
}

# -----------------------------------------------------------------------------
# AC #4/#5 — identity is explicit configuration read before any metadata probe,
# and the public address is asserted genuinely routable, not merely present.
# -----------------------------------------------------------------------------
run "identity_is_explicit_and_public_ip_is_asserted_routable" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nINSTANCE_ID_OVERRIDE=$INSTANCE_ID\n")
    error_message = "The boot .env must set INSTANCE_ID_OVERRIDE — the app checks it before any metadata probe, removing the hostname-fallback split-brain path"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "is not publicly routable")
    error_message = "PUBLIC_IP must be asserted routable (private/CGNAT/link-local ranges rejected), not merely non-empty"
  }
}

# -----------------------------------------------------------------------------
# Ticket 23 — target-group registration is ENTIRELY ASG-managed: the ASG
# carries the target group ARN (attach-on-launch, deregister-on-terminate) and
# health-checks through the ELB. The loadbalancer module has no per-instance
# attachment resource, and no deploy script may call a load-balancer API.
# -----------------------------------------------------------------------------
run "target_registration_is_asg_managed" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  assert {
    condition     = length(aws_autoscaling_group.msab.target_group_arns) == 1
    error_message = "The ASG must own target-group registration via target_group_arns — never a script or per-instance attachment"
  }

  assert {
    condition     = aws_autoscaling_group.msab.health_check_type == "ELB"
    error_message = "ASG health checks must come from the target group (ELB), matching the explicit health_check block in modules/loadbalancer"
  }
}

# =============================================================================
# aws-production 02 — release the instance only after the health gate (F4 + F6)
# =============================================================================
# The defect: the launch hook completed BEFORE `docker run` and the /health wait,
# so the EXIT trap's ABANDON after either failure was a no-op (AWS will not take
# back a completed hook) — an InService instance serving nothing. These runs pin
# BOTH orderings: ticket 19's installs stay above `docker run` (asserted in
# bootstrap_fails_closed_before_traffic), and the hook CONTINUE lands strictly
# after the health gate. F6: HEALTH_MAX_WAIT and the hook heartbeat derive from
# the same budgets, so health ceiling and hook timing cannot drift apart.
# -----------------------------------------------------------------------------
run "launch_hook_completes_only_after_health_gate" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  # The CONTINUE block sits AFTER the health gate's fail-closed exit ("did not
  # pass within" is the gate's FATAL message — everything past it only runs when
  # HEALTH_OK=1). The drain script's terminate-hook CONTINUE renders far earlier,
  # so both the hook name and the result are asserted on this suffix.
  assert {
    condition     = strcontains(split("did not pass within", output.user_data_rendered)[1], "--lifecycle-hook-name \"msab-launch-hook\"")
    error_message = "The launch hook's CONTINUE must be the LAST act of a successful boot — strictly after the /health 200 gate"
  }

  assert {
    condition     = strcontains(split("did not pass within", output.user_data_rendered)[1], "--lifecycle-action-result \"CONTINUE\"")
    error_message = "The block after the health gate must complete the hook with CONTINUE — release-to-fleet is the reward for passing /health, nothing else"
  }

  # …and the health gate itself sits after `docker run` (the container must exist
  # before its health can gate anything).
  assert {
    condition     = strcontains(split("docker run -d", output.user_data_rendered)[1], "\nHEALTH_MAX_WAIT=")
    error_message = "The /health wait must run after `docker run` — it is the release gate for the container just started"
  }

  # F6 — the ceiling is rendered from container_warmup_seconds, never a literal.
  assert {
    condition     = strcontains(output.user_data_rendered, "\nHEALTH_MAX_WAIT=${var.container_warmup_seconds}\n")
    error_message = "HEALTH_MAX_WAIT must render from var.container_warmup_seconds — the free-standing 120 literal was the only underived number in the script (F6)"
  }

  # The launch-hook heartbeat is derived from the SAME budgets…
  assert {
    condition     = aws_autoscaling_lifecycle_hook.launching.heartbeat_timeout == var.container_warmup_seconds + var.bootstrap_overhead_seconds + var.launch_hook_margin_seconds
    error_message = "Launch-hook heartbeat must be derived as bootstrap overhead + health ceiling + margin, not a free literal"
  }

  # …and provably exceeds the worst-case boot-to-health (bootstrap overhead +
  # the full health wait), so a slow-but-healthy boot is never ABANDONed.
  assert {
    condition     = aws_autoscaling_lifecycle_hook.launching.heartbeat_timeout > var.bootstrap_overhead_seconds + var.container_warmup_seconds
    error_message = "Launch-hook heartbeat must STRICTLY exceed worst-case boot-to-health (260s bootstrap + 90s health ceiling = 350s) — at the boundary, hook expiry races the CONTINUE call"
  }

  # Today's numbers: 260 + 90 + 250 = 600 — the proven cold-start window preserved.
  assert {
    condition     = aws_autoscaling_lifecycle_hook.launching.heartbeat_timeout == 600
    error_message = "Default launch-hook heartbeat must reproduce the proven 600s window (260 + 90 + 250)"
  }
}

# -----------------------------------------------------------------------------
# The derivation must be real, not today's numbers restated: change the health
# budget and BOTH the rendered ceiling and the hook heartbeat must track it.
# -----------------------------------------------------------------------------
run "health_ceiling_and_hook_heartbeat_move_together" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    container_warmup_seconds   = 77
    bootstrap_overhead_seconds = 300
    launch_hook_margin_seconds = 100
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "\nHEALTH_MAX_WAIT=77\n")
    error_message = "HEALTH_MAX_WAIT must track a changed container_warmup_seconds (77)"
  }

  assert {
    condition     = aws_autoscaling_lifecycle_hook.launching.heartbeat_timeout == 477
    error_message = "Launch-hook heartbeat must track changed budgets (300 + 77 + 100 = 477)"
  }

  assert {
    condition     = aws_autoscaling_group.msab.health_check_grace_period == 377
    error_message = "The ELB grace period must move with the same budgets (300 + 77 = 377) — one physical event, one derivation"
  }
}

# -----------------------------------------------------------------------------
# A margin thin enough to be eaten by estimate error in the provisional
# bootstrap itemisation must fail at plan — every boot would time out
# mid-bootstrap and the ASG would replace instances forever.
# -----------------------------------------------------------------------------
run "launch_hook_margin_rejects_too_thin_a_value" {
  command = plan

  module {
    source = "./modules/autoscaling"
  }

  variables {
    launch_hook_margin_seconds = 30
  }

  expect_failures = [
    var.launch_hook_margin_seconds,
  ]
}
