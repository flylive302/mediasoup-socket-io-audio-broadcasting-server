# =============================================================================
# Loadgen Module — short-lived, hand-triggered load-generator box (STAGING ONLY)
# =============================================================================
# aws-production/08: a spot box that runs scripts/load-harness (real Opus
# encode/decode fleet) against the staging MSAB instance, plus a local
# Prometheus that scrapes MSAB's own /metrics/prometheus and a node_exporter
# installed by hand on the MSAB box (docs/runbooks/msab-loadgen-campaign.md).
#
# ⛔ Ships INERT (var.enabled default false). Even if flipped true, EVERY
# resource here is additionally gated on environment == "staging" — see
# local.loadgen_enabled below — so a production plan can never render this
# module. This mirrors the pattern modules/iam uses for enable_event_queue_consume
# (a static flag, never a computed value, gates count/for_each).
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  # Ticket 31 / decision D3 naming pattern, same as every other module —
  # redeclared here because there is no shared naming module (see every other
  # module's main.tf for the identical comment/local).
  env_prefix = "${var.project_name}-${var.environment}"

  # Single gate, referenced by EVERY resource in this module (including the
  # data source, so a production plan issues zero describe-images calls for a
  # box that can never render). Factored into one local — not repeated as a
  # literal ternary on each resource — so the nine-plus resources below can
  # never drift apart into different gates by a copy-paste typo.
  loadgen_enabled = var.enabled && var.environment == "staging"

  # s3://bucket/key(/...) -> arn:aws:s3:::bucket/key(/...) — the exact-object
  # ARN form, never bucket-wide. trimprefix() is enough: an S3 object ARN is
  # literally "arn:aws:s3:::" + the bucket/key path, with no region or account
  # segment. Empty when harness_s3_uri is empty, so the s3:GetObject grant
  # below is skipped rather than rendered with a bogus empty-string resource.
  harness_s3_object_arn = var.harness_s3_uri != "" ? "arn:aws:s3:::${trimprefix(var.harness_s3_uri, "s3://")}" : ""
}

# --- Ubuntu 24.04 (noble) AMI, amd64 only ---
# ⚠️ amd64 is NOT a placeholder default here (contrast modules/autoscaling,
# which supports arm64 via var.instance_architecture) — @roamhq/wrtc, a
# load-harness dependency, resolves a platform-specific PREBUILT binary via
# optional dependencies (scripts/load-harness/README.md, runbook step 4's
# proof step). An arm64 box would fail at `require()` time, after boot, after
# npm install already "succeeded". Copied from modules/autoscaling/main.tf's
# data.aws_ami.ubuntu, arch token hardcoded instead of variable-driven.
data "aws_ami" "ubuntu" {
  count = local.loadgen_enabled ? 1 : 0

  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- Security Group: no inbound at all ---
# Shell access is SSM Session Manager (IAM, not a port); Prometheus is local
# to this box (scripts/loadgen-netem.sh and the harness both run ON it, they
# don't need to reach IN). The only thing this box needs FROM the network is
# egress — to npm/GitHub/S3 for delivery, and to the MSAB box's public IP for
# both the app port and the node_exporter scrape (opened on the MSAB side's
# security group instead — see modules/networking's loadgen_security_group_id
# wiring — not here; this SG only needs to be a valid EGRESS source for that
# rule to reference).
resource "aws_security_group" "loadgen" {
  count = local.loadgen_enabled ? 1 : 0

  name = "${local.env_prefix}-loadgen"

  # 🔴 ASCII ONLY. EC2 rejects CreateSecurityGroup with
  # "InvalidParameterValue: ... Character sets beyond ASCII are not supported"
  # if GroupDescription contains so much as an em-dash. Proven the hard way on
  # the 2026-08-12 apply: this string used "—" and the apply failed AFTER the
  # IAM resources had already been created. `terraform test` cannot catch it —
  # mock_provider does not enforce AWS's charset validation — so the only guard
  # is this comment and a real plan/apply.
  # Terraform variable/output `description` fields are exempt: they never leave
  # Terraform. This restriction applies to AWS resource arguments only.
  description = "Load-generator box (aws-production/08) - no ingress by design; SSM Session Manager for shell, egress-only otherwise"
  vpc_id      = var.vpc_id

  # ⛔ Deliberately ZERO ingress blocks. Do not add one "for debugging" — see
  # header comment. tests/loadgen.tftest.hcl asserts this stays empty.

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${local.env_prefix}-loadgen"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- IAM Role ---
resource "aws_iam_role" "loadgen" {
  count = local.loadgen_enabled ? 1 : 0

  name = "${local.env_prefix}-loadgen"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Project = var.project_name
  }
}

# --- Inline policy: discover the MSAB target (read-only) + read boot secrets ---
resource "aws_iam_role_policy" "loadgen" {
  count = local.loadgen_enabled ? 1 : 0

  name = "${local.env_prefix}-loadgen"
  role = aws_iam_role.loadgen[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # Read-only, account-wide: EC2 does not support resource-level scoping
          # for DescribeInstances. Needed to discover the MSAB target instance by
          # tag when var.msab_target_host is left empty (user-data.sh step d).
          Effect = "Allow"
          Action = [
            "ec2:DescribeInstances",
          ]
          Resource = "*"
        },
        {
          # Same env-qualified prefix modules/iam scopes the MSAB instance role
          # to — reads the LARAVEL_INTERNAL_KEY (var.internal_key_ssm_path) that
          # authenticates the Prometheus scrape of /metrics/prometheus.
          Effect = "Allow"
          Action = [
            "ssm:GetParameter",
            "ssm:GetParameters",
          ]
          Resource = "arn:aws:ssm:*:*:parameter/${local.env_prefix}/*"
        },
      ],
      # 🔴 The parameter above is a SecureString under a customer-managed CMK, so
      # ssm:GetParameter --with-decryption ALSO needs kms:Decrypt on that key.
      # Without it the boot script dies with
      #   "not authorized to perform: kms:Decrypt on resource: arn:aws:kms:..."
      # — and because that happens in user-data, the APPLY SUCCEEDS and the box
      # comes up broken. Proven on the 2026-08-12 first boot; the only symptom
      # was a missing /opt/loadgen-READY and a line in cloud-init-output.log.
      # modules/ssm grants the identical thing to the shared EC2 instance role
      # (aws_iam_role_policy.ssm_kms_decrypt); this is that grant for the
      # loadgen role, which lives outside that module. Scoped to the one key.
      #
      # Appended via concat rather than a separate aws_iam_role_policy so the
      # gate stays on local.loadgen_enabled: var.kms_key_arn comes from a module
      # output and would be UNKNOWN at plan time on a from-scratch apply, and an
      # unknown value can never gate count/for_each.
      var.kms_key_arn != "" ? [
        {
          Effect   = "Allow"
          Action   = ["kms:Decrypt"]
          Resource = var.kms_key_arn
        },
      ] : [],
    )
  })
}

# --- Inline policy: pull the pre-built harness tarball (ONE object, never the bucket) ---
resource "aws_iam_role_policy" "loadgen_s3" {
  count = local.loadgen_enabled && var.harness_s3_uri != "" ? 1 : 0

  name = "${local.env_prefix}-loadgen-s3"
  role = aws_iam_role.loadgen[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = local.harness_s3_object_arn
      }
    ]
  })
}

# --- SSM Session Manager — the ONLY shell access path (no SSH, no port 22) ---
resource "aws_iam_role_policy_attachment" "loadgen_ssm" {
  count = local.loadgen_enabled ? 1 : 0

  role       = aws_iam_role.loadgen[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# --- Instance Profile ---
resource "aws_iam_instance_profile" "loadgen" {
  count = local.loadgen_enabled ? 1 : 0

  name = "${local.env_prefix}-loadgen"
  role = aws_iam_role.loadgen[0].name

  tags = {
    Project = var.project_name
  }
}

# Rendered user-data script. Kept as a local (and exposed via the
# user_data_rendered output) so tests can assert on the plain text — the
# instance carries it gzipped, which base64decode() alone can't unpack.
# Mirrors modules/autoscaling/main.tf's identical pattern/comment.
#
# NOT count-gated: rendering a string costs nothing (no AWS call), and the
# output must stay computable even when the module is disabled so
# tests/loadgen.tftest.hcl can assert on it without needing var.enabled=true.
#
# ⚠️ project_name + environment are threaded through IN ADDITION to env_prefix
# (a deviation from the task's literal 7-variable list — see the report for
# this task). user-data.sh's MSAB discovery (step d) needs the bare Project
# and Environment tag VALUES to filter EC2 instances the same way
# docs/runbooks/msab-loadgen-campaign.md step 0 and .github/workflows/deploy.yml
# already do — env_prefix alone (the two values already joined with "-") can't
# be losslessly split back apart, and hardcoding "staging" as a bash literal
# would silently desync from local.loadgen_enabled's own environment check.
locals {
  user_data_rendered = templatefile("${path.module}/user-data.sh", {
    project_name          = var.project_name
    environment           = var.environment
    region                = var.region
    env_prefix            = local.env_prefix
    msab_target_host      = var.msab_target_host
    msab_app_port         = var.msab_app_port
    internal_key_ssm_path = var.internal_key_ssm_path
    prometheus_version    = var.prometheus_version
    harness_s3_uri        = var.harness_s3_uri
  })
}

# --- The load-generator instance itself ---
resource "aws_instance" "loadgen" {
  count = local.loadgen_enabled ? 1 : 0

  ami           = data.aws_ami.ubuntu[0].id
  instance_type = var.instance_type

  # SPOT — this box is hand-triggered, short-lived, and disposable per campaign
  # (aws-production/08: "cheap to start and destroy per run"). A spot
  # interruption mid-run voids that run's numbers but costs nothing else; the
  # runbook's own abort criteria treat interruption as "re-run", not an incident.
  instance_market_options {
    market_type = "spot"
    spot_options {
      instance_interruption_behavior = "terminate"
    }
  }

  # Public subnet + a public IP — this box needs egress for npm/AWS CLI/S3
  # installs and to reach the MSAB box's public IP (the same public-IP path
  # cascade already uses between MSAB instances); the private subnets in this
  # stack have no NAT gateway, so a private placement would have no egress at all.
  subnet_id                   = var.public_subnet_id
  associate_public_ip_address = true

  vpc_security_group_ids = [aws_security_group.loadgen[0].id]
  iam_instance_profile   = aws_iam_instance_profile.loadgen[0].name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    encrypted             = true
    delete_on_termination = true
  }

  # IMDSv2-required — matches every other EC2-launching resource in this repo
  # (modules/autoscaling's launch template). Not otherwise used by user-data.sh
  # (this script has no need to read its own instance identity), but it costs
  # nothing to close off IMDSv1 by default.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  # Gzipped for the same reason modules/autoscaling gzips its user_data: the
  # rendered script comfortably exceeds a few KB once the Prometheus config and
  # netem/discovery logic are inlined, and cloud-init decompresses transparently.
  user_data = base64gzip(local.user_data_rendered)

  # 🔴 Without this, the AWS provider treats a user_data change as an in-place
  # attribute update: `terraform plan` reports "will be updated in-place",
  # the apply succeeds, and the running box KEEPS ITS OLD BOOTSTRAP because
  # user-data only executes at launch. Every edit to user-data.sh would look
  # applied and do nothing. Caught 2026-08-12 while fixing the scrape config —
  # the plan said "0 to add, 1 to change, 0 to destroy" for a change that
  # rewrites the entire Prometheus configuration.
  # Safe here precisely because this box is disposable and hand-triggered:
  # replacing it is the intended way to pick up a change. ⛔ Do NOT copy this
  # onto anything serving traffic.
  user_data_replace_on_change = true

  tags = {
    Name        = "${local.env_prefix}-loadgen"
    Environment = var.environment
    Project     = var.project_name
    # Signals "safe to destroy any time, nothing depends on this surviving a
    # reboot or a redeploy" — distinguishes this box from the ACTUAL fleet at a
    # glance in the console, which is the whole point of a hand-triggered,
    # start/destroy-per-run resource (aws-production/08).
    Ephemeral = "true"
  }
}
