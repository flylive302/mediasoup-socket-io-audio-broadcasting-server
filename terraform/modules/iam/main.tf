# =============================================================================
# IAM Module — EC2 Instance Profile for MSAB
# =============================================================================
# Provides IAM role + instance profile with permissions for:
#   - CloudWatch PutMetricData (custom metrics)
#   - Auto Scaling lifecycle hooks (complete + describe)
#   - EC2 metadata (describe instances)
# =============================================================================

# --- IAM Role ---
resource "aws_iam_role" "msab" {
  name = "${var.project_name}-ec2-role"

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

# --- CloudWatch Metrics Policy ---
resource "aws_iam_role_policy" "cloudwatch_metrics" {
  name = "${var.project_name}-cloudwatch-metrics"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "FlyLive/MSAB"
          }
        }
      }
    ]
  })
}

# --- Auto Scaling Lifecycle Policy ---
resource "aws_iam_role_policy" "asg_lifecycle" {
  name = "${var.project_name}-asg-lifecycle"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "autoscaling:CompleteLifecycleAction",
          "autoscaling:DescribeAutoScalingInstances",
          "autoscaling:RecordLifecycleActionHeartbeat",
        ]
        Resource = "*"
      }
    ]
  })
}

# --- EC2 Describe Policy (for metadata enrichment) ---
resource "aws_iam_role_policy" "ec2_describe" {
  name = "${var.project_name}-ec2-describe"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeTags",
        ]
        Resource = "*"
      }
    ]
  })
}

# --- CloudWatch Log Group — MSAB container logs (shipped by the CloudWatch
# Agent installed in modules/autoscaling/user-data.sh:264-292). The runtime
# agent config there hard-codes log_group_name = "/flylive-audio/msab"; this
# resource name is built from the same var.project_name as everything else
# in this module so the two can never desync (bash and Terraform can't share
# a variable, so this is enforced by convention + this comment, not code —
# if project_name ever changes, user-data.sh's literal must be updated too).
#
# retention_in_days is explicit (not left at the provider default of "never
# expire"): 30 days is an operational debugging window for a realtime audio
# service — enough to investigate rooms/seats/connection-drop incidents
# after the fact. Costs stay bounded, and incidents older than a month are
# investigated from docs/metrics (dashboards, postmortems), not raw
# container logs. See var.log_retention_days if this ever needs to change
# per-environment.
#
# Region note: CloudWatch Logs is regional; this group is created under the
# module's default (unaliased) aws provider, which main.tf pins to Mumbai
# (ap-south-1) — the same region "module region_mumbai" runs in. That's
# correct today because var.enabled_regions defaults to ["mumbai"] only
# (Frankfurt/Singapore are defined but off — see variables.tf ticket-11
# comment). If a second region is ever enabled, its instances need a log
# group in THEIR region too; this single resource won't cover them, and the
# CreateLogGroup permission removed below (agent config in
# modules/autoscaling/user-data.sh) means shipping would fail silently there
# instead of self-healing. Revisit placement (per-region, in modules/region
# or modules/autoscaling) before turning on a second region.
resource "aws_cloudwatch_log_group" "msab" {
  name              = "/${var.project_name}/msab"
  retention_in_days = var.log_retention_days

  tags = {
    Project = var.project_name
  }
}

# --- CloudWatch Logs Policy (for the CloudWatch Agent shipping Docker logs) ---
# logs:CreateLogGroup is deliberately NOT granted here — narrower than AWS's
# own managed CloudWatchAgentServerPolicy, which does include CreateLogGroup.
# aws_cloudwatch_log_group.msab above is the only group this agent config
# writes to (one collect_list entry, log_group_name is a fixed string, not
# templated per instance/day — modules/autoscaling/user-data.sh:264-292), so
# the agent only ever needs to create its per-instance log STREAM
# ({instance_id}) inside that pre-existing group and write to it — never a
# group. Terraform now owns the group's existence and retention.
# Trade-off, stated plainly: this is a deliberate tightening below AWS's
# recommended policy, not a verified requirement from AWS docs. The
# consequence if the group is ever missing in a region this role runs in
# (e.g. a future region enabled without provisioning its own group — see the
# region note above) is that log shipping fails outright instead of
# self-healing. Re-add CreateLogGroup if that trade-off stops being
# acceptable.
resource "aws_iam_role_policy" "cloudwatch_logs" {
  name = "${var.project_name}-cloudwatch-logs"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ]
        Resource = "arn:aws:logs:*:*:log-group:/${var.project_name}/*"
      }
    ]
  })
}

# --- ECR Pull Policy ---
resource "aws_iam_role_policy" "ecr_pull" {
  name = "${var.project_name}-ecr-pull"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability",
        ]
        Resource = "*"
      }
    ]
  })
}

# --- SSM Parameter Store — fetch secrets at boot ---
resource "aws_iam_role_policy" "ssm_parameters" {
  name = "${var.project_name}-ssm-parameters"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
        ]
        Resource = "arn:aws:ssm:*:*:parameter/${var.project_name}/*"
      }
    ]
  })
}

# --- SQS consumer — ticket 25: queue access is IAM-role-based, no shared secret ---
# Consume-side only, scoped to the ONE msab-events queue. Send is deliberately
# absent: the producer is Laravel (ticket 27), which gets its own principal —
# an instance that could write its own economy events would be a forgery path.
resource "aws_iam_role_policy" "sqs_consume" {
  # Gated on a static flag, not on the ARN being non-empty — the ARN is
  # computed (unknown at plan), and count may not depend on unknown values.
  count = var.enable_event_queue_consume ? 1 : 0
  name  = "${var.project_name}-sqs-consume"
  role  = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ChangeMessageVisibility",
        ]
        Resource = var.event_queue_arn
      }
    ]
  })
}

# --- SSM Session Manager — replaces SSH (browser-based shell via AWS Console) ---
resource "aws_iam_role_policy_attachment" "ssm_session_manager" {
  role       = aws_iam_role.msab.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# --- Instance Profile ---
resource "aws_iam_instance_profile" "msab" {
  name = "${var.project_name}-ec2-profile"
  role = aws_iam_role.msab.name

  tags = {
    Project = var.project_name
  }
}

# =============================================================================
# CI/CD Deploy Identity — GitHub Actions via OIDC federation (deploy.yml)
# =============================================================================
# Ticket 12: no long-lived access key. GitHub Actions presents a short-lived
# OIDC token from token.actions.githubusercontent.com and assumes a role whose
# trust policy is pinned to this repository AND the specific GitHub deployment
# environment (var.github_environment). A job running under any other repo or
# environment cannot assume it — that (plus per-env state/VPC, tickets 09/11)
# is the blast-radius wall a single AWS account (D5) otherwise lacks.
#
# The role is capped by a permissions boundary (below): even if a broader
# policy is ever attached to it by mistake, effective permissions can never
# exceed exactly what deploy.yml needs — ECR push to the MSAB repo + ASG
# instance refresh. Nothing to paste into GitHub secrets except the role ARN
# (github_actions_role_arn output — NOT sensitive; role ARNs are not secrets).
# =============================================================================

# GitHub's OIDC identity provider — one per account. thumbprint_list is
# vestigial (AWS trusts GitHub's root CA directly since 2023) but the argument
# is still required by the resource; these are GitHub's published thumbprints.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  tags = {
    Project = var.project_name
  }
}

# --- Permissions boundary: the deploy identity's hard ceiling ---
# A boundary does not GRANT anything — it caps the maximum. The role's
# effective permissions are (attached policies ∩ this boundary).
resource "aws_iam_policy" "github_actions_boundary" {
  name        = "${var.project_name}-gha-deploy-boundary"
  description = "Permissions boundary for the GitHub Actions deploy role — caps it at ECR push (MSAB repo only) + ASG instance refresh, regardless of what policies get attached later"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages",
        ]
        Resource = var.ecr_repository_arn
      },
      {
        Effect = "Allow"
        Action = [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:DescribeInstanceRefreshes",
          "autoscaling:DescribeLifecycleHooks",
          "autoscaling:DescribeScalingActivities",
          "autoscaling:StartInstanceRefresh",
          "autoscaling:CancelInstanceRefresh",
          "autoscaling:CompleteLifecycleAction",
        ]
        Resource = "*"
      },
      {
        # Ticket 29: deploy.yml's failure-rescue step un-drains a stranded instance
        # via SSM Run Command — the curl runs ON the instance against localhost, so
        # the internal key never crosses the network. SendCommand is scoped to the
        # stock shell document + this project's tagged instances only.
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:aws:ssm:*::document/AWS-RunShellScript",
          "arn:aws:ec2:*:*:instance/*",
        ]
        Condition = {
          StringEqualsIfExists = {
            "ssm:resourceTag/Project" = var.project_name
          }
        }
      },
      {
        # Result readback for the rescue step. Read-only; not resource-scopable.
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation"]
        Resource = "*"
      },
    ]
  })

  tags = {
    Project = var.project_name
  }
}

# Plan-known copy of the trust policy's sub claim, so the offline test suite
# can assert the repo+environment pin (the rendered assume_role_policy embeds
# the OIDC provider ARN, which is unknown at plan time).
locals {
  github_oidc_sub = "repo:${var.github_repository}:environment:${var.github_environment}"
}

resource "aws_iam_role" "github_actions" {
  name                 = "${var.project_name}-github-actions"
  permissions_boundary = aws_iam_policy.github_actions_boundary.arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            # Only jobs running under THIS repo's THIS deployment environment.
            # GitHub environments carry the required-reviewer gate, so this also
            # means: only a run a human approved can assume the role.
            "token.actions.githubusercontent.com:sub" = local.github_oidc_sub
          }
        }
      }
    ]
  })

  tags = {
    Project = var.project_name
    Purpose = "ci-cd-deploy"
  }
}

# --- ECR push: authenticate + push image (build-and-push job) ---
resource "aws_iam_role_policy" "github_actions_ecr_push" {
  name = "${var.project_name}-gha-ecr-push"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetAuthorizationToken is account-wide and does not support resource scoping.
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        # Push + cache-pull + verify, scoped to the MSAB repository only.
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages",
        ]
        Resource = var.ecr_repository_arn
      }
    ]
  })
}

# --- ASG instance refresh: roll new image into both regions (deploy job) ---
resource "aws_iam_role_policy" "github_actions_asg_refresh" {
  name = "${var.project_name}-gha-asg-refresh"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Autoscaling Describe* / refresh APIs do not support resource-level scoping.
        Effect = "Allow"
        Action = [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:DescribeInstanceRefreshes",
          "autoscaling:DescribeLifecycleHooks",
          "autoscaling:DescribeScalingActivities",
          "autoscaling:StartInstanceRefresh",
          "autoscaling:CancelInstanceRefresh",
          "autoscaling:CompleteLifecycleAction",
        ]
        Resource = "*"
      },
      {
        # Ticket 29: un-drain rescue via SSM Run Command — see the boundary copy above.
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:aws:ssm:*::document/AWS-RunShellScript",
          "arn:aws:ec2:*:*:instance/*",
        ]
        Condition = {
          StringEqualsIfExists = {
            "ssm:resourceTag/Project" = var.project_name
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation"]
        Resource = "*"
      }
    ]
  })
}
