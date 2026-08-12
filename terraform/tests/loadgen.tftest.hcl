# =============================================================================
# Loadgen module (aws-production/08) — rendered-plan assertions
# =============================================================================
# Offline, mocked-provider tests (no API calls, no cost, no credentials) — same
# pattern as tests/naming_modules.tftest.hcl. Every run here is MODULE-SCOPED
# (`module { source = "./modules/..." }`) on purpose: a module-scoped run
# re-types the mock providers for the WHOLE FILE, so this file never mixes in
# a root-scoped run — that would break the `cloudflare` mock the root-scoped
# plan needs (see naming_modules.tftest.hcl's header and
# docs/reference/hard-won-gotchas.md's "bogus Provider type mismatch" entry).
#
# Two modules are exercised here: ./modules/loadgen itself, and
# ./modules/networking (for the msab security group's port-9100 rule that
# modules/loadgen's existence implies).
#
# ⚠️ Deviation from the task's literal "msab 9100 ingress exists only when the
# loadgen SG id is non-empty" framing: the real gate is a SEPARATE static bool,
# var.loadgen_ingress_enabled — NOT `loadgen_security_group_id != ""`. Gating
# on the id directly fails plan with "Invalid for_each argument" whenever
# loadgen is actually enabled, because the id is then a computed attribute
# (aws_security_group.loadgen[0].id), unknown at plan time, and for_each
# cannot depend on an unknown value. See modules/networking/variables.tf's
# comment (mirrors the existing modules/iam sqs_consume precedent). The tests
# below assert the two variables together, which is the same property the
# task asked for: the rule appears exactly when loadgen's SG would exist, and
# its source is that SG, never a CIDR.
# =============================================================================

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["mock-az-a", "mock-az-b", "mock-az-c"]
      zone_ids = ["mock-az-id-a", "mock-az-id-b", "mock-az-id-c"]
    }
  }
}

# Superset fixture (same idiom as naming_modules.tftest.hcl): the union of
# every required (no-default) input across modules/loadgen and
# modules/networking. Each module-scoped run below consumes only the subset
# its own module declares.
variables {
  # modules/loadgen
  project_name          = "flylive-audio"
  environment           = "staging"
  public_subnet_id      = "subnet-0mockpublic0000a"
  vpc_id                = "vpc-0mock000000000000"
  internal_key_ssm_path = "/flylive-audio-staging/laravel-internal-key"
  region                = "ap-south-1"

  # modules/networking
  vpc_cidr           = "10.120.0.0/16"
  app_port           = 3030
  rtc_min_port       = 10000
  rtc_max_port       = 10063
  cascade_ports_open = true
}

# -----------------------------------------------------------------------------
# Production can NEVER render this module, no matter how var.enabled is set —
# local.loadgen_enabled = var.enabled && var.environment == "staging".
# -----------------------------------------------------------------------------
run "production_never_renders_even_when_enabled_is_true" {
  command = plan

  module {
    source = "./modules/loadgen"
  }

  variables {
    environment = "production"
    enabled     = true
  }

  assert {
    condition     = length(aws_instance.loadgen) == 0
    error_message = "environment=production must render ZERO loadgen instances even with enabled=true — production must never be reachable by this flag alone"
  }

  assert {
    condition     = length(aws_security_group.loadgen) == 0 && length(aws_iam_role.loadgen) == 0 && length(aws_iam_instance_profile.loadgen) == 0
    error_message = "environment=production must render zero of every loadgen resource (SG, IAM role, instance profile)"
  }
}

# -----------------------------------------------------------------------------
# Ships inert by default: staging alone is not enough, enabled must also be true.
# -----------------------------------------------------------------------------
run "staging_with_enabled_false_renders_nothing" {
  command = plan

  module {
    source = "./modules/loadgen"
  }

  variables {
    environment = "staging"
    enabled     = false
  }

  assert {
    condition     = length(aws_instance.loadgen) == 0
    error_message = "environment=staging + enabled=false (the default) must render zero loadgen instances — the module ships inert"
  }
}

# -----------------------------------------------------------------------------
# The one case that actually stands the box up: staging + enabled=true.
# -----------------------------------------------------------------------------
run "staging_with_enabled_true_renders_one_spot_instance" {
  # command = apply, not plan: aws_security_group.loadgen declares ZERO
  # ingress blocks (not even an empty dynamic one), and ingress/egress on
  # aws_security_group are Optional+Computed in the provider schema — with
  # nothing at all in config for that attribute, its value is unknown at plan
  # time under a mocked provider (confirmed empirically: `command = plan` here
  # fails with "Unknown condition value" on aws_security_group.loadgen[0].ingress).
  # Same reasoning/precedent as tests/dynamic_metric_discovery.tftest.hcl and
  # tests/ssm_kms.tftest.hcl's apply runs — mock_provider fabricates every
  # resource in memory, nothing real is touched.
  command = apply

  module {
    source = "./modules/loadgen"
  }

  variables {
    environment = "staging"
    enabled     = true
  }

  assert {
    condition     = length(aws_instance.loadgen) == 1
    error_message = "environment=staging + enabled=true must render exactly ONE loadgen instance"
  }

  assert {
    condition     = aws_instance.loadgen[0].instance_market_options[0].market_type == "spot"
    error_message = "the loadgen instance must be SPOT — aws-production/08: cheap to start and destroy per run, spot interruption is an acceptable/expected failure mode"
  }

  assert {
    condition     = aws_instance.loadgen[0].tags["Name"] == "flylive-audio-staging-loadgen"
    error_message = "the loadgen instance's Name tag must be env-qualified and contain \"staging\" (ticket 31 / D3 naming — local.env_prefix)"
  }

  assert {
    condition     = aws_instance.loadgen[0].tags["Ephemeral"] == "true"
    error_message = "the loadgen instance must carry Ephemeral=true — it is explicitly disposable, unlike the ASG fleet"
  }

  assert {
    condition     = length(aws_security_group.loadgen[0].ingress) == 0
    error_message = "the loadgen security group must have ZERO ingress rules — shell access is SSM Session Manager (IAM), not a port; Prometheus/the harness are local to the box"
  }

  assert {
    condition     = length(aws_iam_instance_profile.loadgen) == 1 && length(aws_iam_role_policy_attachment.loadgen_ssm) == 1
    error_message = "an enabled loadgen box must have an instance profile and the AmazonSSMManagedInstanceCore attachment — SSM is the only shell access path"
  }

  # --- Rendered user-data.sh assertions (output.user_data_rendered) ---
  # `validate` only proves the template PARSES (it caught a real bug: a
  # literal ${...} in a prose comment). It does not prove the $${...}
  # escaping produced the right bash on the other side. Same idiom as
  # tests/drain_window.tftest.hcl's rendered_script_sanitizes_secrets_for_the_env_file.
  assert {
    # The netem helper's positional-arg check is the single highest-risk line
    # in the whole file for the $${...} trap (task's own words). The STRING
    # LITERAL below needs $$ too, for the identical reason the .sh file does:
    # .tftest.hcl is HCL, and HCL applies the exact same $${ -> ${ escaping to
    # its OWN string interpolation. Written plainly, this line asserts the
    # RENDERED script contains a literal, bash-interpretable ${1:-} — not a
    # broken half-escaped $${1:-} and not an "Invalid template interpolation"
    # failure (which would have already failed at `plan`, before this assert
    # ever runs).
    condition     = strcontains(output.user_data_rendered, "$${1:-}")
    error_message = "loadgen-netem.sh's positional-arg default (dollar-brace-one-colon-dash-brace) must render with a single leading dollar sign for bash to interpret — the doubled-dollar escape must have survived templatefile() intact"
  }

  assert {
    # honor_labels: true must appear on BOTH scrape jobs (msab AND node) — a
    # single occurrence would mean one job is missing it, which silently
    # renames MSAB's own region/instance labels to exported_* and breaks
    # every SLO query (docs/runbooks/msab-loadgen-campaign.md step 3, row 5;
    # scripts/load-harness/README.md). Matched WITH its 4-space YAML
    # indentation, not just the bare phrase — the script's own explanatory
    # comment above the heredoc also happens to contain the bare phrase
    # (confirmed empirically: the unindented match counted 3, not 2), so the
    # indentation is what disambiguates actual config from prose about it.
    condition     = length(regexall("    honor_labels: true", output.user_data_rendered)) == 2
    error_message = "honor_labels: true must appear exactly twice, correctly indented, in the rendered Prometheus config — once per scrape job (msab, node)"
  }

  assert {
    condition     = strcontains(output.user_data_rendered, "/opt/loadgen-READY")
    error_message = "the rendered script must write the /opt/loadgen-READY marker — the operator's single boot-complete signal"
  }

  assert {
    # The internal key's VALUE must never be logged. This can't prove the
    # runtime value is safe (that's not knowable at plan time), but it does
    # prove the script never pipes the variable holding it through echo/log —
    # the class of mistake that would leak it into /var/log/loadgen-user-data.log.
    condition     = !strcontains(output.user_data_rendered, "echo \"$INTERNAL_KEY_VALUE\"") && !strcontains(output.user_data_rendered, "echo $INTERNAL_KEY_VALUE")
    error_message = "the internal key variable must never be echoed — it would land in /var/log/loadgen-user-data.log"
  }
}

# -----------------------------------------------------------------------------
# The S3 harness-delivery grant is conditional on var.harness_s3_uri, INDEPENDENT
# of the base enable gate — must render neither too eagerly nor too narrowly.
# -----------------------------------------------------------------------------
run "s3_policy_absent_when_harness_uri_empty" {
  command = plan

  module {
    source = "./modules/loadgen"
  }

  variables {
    environment    = "staging"
    enabled        = true
    harness_s3_uri = ""
  }

  assert {
    condition     = length(aws_iam_role_policy.loadgen_s3) == 0
    error_message = "harness_s3_uri = \"\" (the default) must render zero S3 grants — nothing to scope them to"
  }
}

run "s3_policy_scoped_to_exactly_one_object_when_harness_uri_set" {
  command = plan

  module {
    source = "./modules/loadgen"
  }

  variables {
    environment    = "staging"
    enabled        = true
    harness_s3_uri = "s3://flylive-loadgen-artifacts/loadgen/load-harness.tgz"
  }

  assert {
    condition     = length(aws_iam_role_policy.loadgen_s3) == 1
    error_message = "a non-empty harness_s3_uri must render exactly one S3 grant"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.loadgen_s3[0].policy, "arn:aws:s3:::flylive-loadgen-artifacts/loadgen/load-harness.tgz")
    error_message = "the S3 grant must be scoped to the exact object ARN derived from harness_s3_uri"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.loadgen_s3[0].policy, "\"Resource\": \"arn:aws:s3:::flylive-loadgen-artifacts\"") && !strcontains(aws_iam_role_policy.loadgen_s3[0].policy, "arn:aws:s3:::flylive-loadgen-artifacts/*")
    error_message = "the S3 grant must NEVER be bucket-wide (no bare bucket ARN, no bucket/* wildcard) — exactly one object only"
  }
}

# -----------------------------------------------------------------------------
# modules/networking: the msab security group's port-9100 ingress-from-loadgen
# rule. See the file header for why this is gated on loadgen_ingress_enabled
# (a static bool) rather than `loadgen_security_group_id != ""`.
# -----------------------------------------------------------------------------
run "msab_9100_ingress_absent_when_loadgen_ingress_disabled" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    loadgen_ingress_enabled   = false
    loadgen_security_group_id = ""
  }

  assert {
    condition     = !anytrue([for i in aws_security_group.msab.ingress : i.from_port == 9100])
    error_message = "loadgen_ingress_enabled = false (the default) must remove the msab SG's 9100 ingress rule entirely"
  }
}

run "msab_9100_ingress_sourced_from_loadgen_sg_not_cidr_when_enabled" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    loadgen_ingress_enabled   = true
    loadgen_security_group_id = "sg-0mockloadgen000000"
  }

  assert {
    condition     = anytrue([for i in aws_security_group.msab.ingress : i.from_port == 9100 && i.to_port == 9100 && i.protocol == "tcp"])
    error_message = "loadgen_ingress_enabled = true must open TCP 9100 on the msab security group (node_exporter scrape target)"
  }

  assert {
    # security_groups is a set(string) — sets have no index, so membership is
    # checked with contains(), not i.security_groups[0] (that fails with
    # "Invalid index": confirmed empirically).
    condition     = anytrue([for i in aws_security_group.msab.ingress : i.from_port == 9100 && length(i.security_groups) == 1 && contains(i.security_groups, "sg-0mockloadgen000000")])
    error_message = "the 9100 rule's source must be the loadgen security group id (var.loadgen_security_group_id), not a CIDR"
  }

  assert {
    condition     = alltrue([for i in aws_security_group.msab.ingress : i.from_port != 9100 || try(length(i.cidr_blocks), 0) == 0])
    error_message = "the 9100 rule must carry no cidr_blocks — its source must be a security group ONLY, never a CIDR (this is the whole point of the rule: only the loadgen box, nothing else on the internet, can reach node_exporter)"
  }

  # Confirms this rule doesn't disturb the OTHER msab ingress rules (app port,
  # WebRTC range, cascade) — an inline dynamic block sharing one resource with
  # static ingress blocks is exactly the pattern tests/plan_assertions.tftest.hcl's
  # networking_opens_only_deliberate_ports run already covers for cascade;
  # this is the same regression class, one rule later. 40000 is the cascade
  # relay rule — present because this run's fixture sets cascade_ports_open =
  # true (file-level variables block).
  assert {
    condition     = alltrue([for i in aws_security_group.msab.ingress : contains([3030, 10000, 40000, 9100], i.from_port)])
    error_message = "adding the loadgen 9100 rule must not introduce or disturb any OTHER ingress opening on the msab security group"
  }
}
