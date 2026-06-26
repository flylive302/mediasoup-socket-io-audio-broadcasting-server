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

# --- CloudWatch Logs Policy (for Docker awslogs driver) ---
resource "aws_iam_role_policy" "cloudwatch_logs" {
  name = "${var.project_name}-cloudwatch-logs"
  role = aws_iam_role.msab.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ]
        Resource = "arn:aws:logs:*:*:log-group:/flylive-audio/*"
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
# CI/CD Deploy User — GitHub Actions (deploy.yml)
# =============================================================================
# Long-lived access key used by .github/workflows/deploy.yml to:
#   - build-and-push: authenticate + push the MSAB image to ECR (ap-south-1)
#   - deploy: trigger an ASG instance refresh in both regions
# Scoped to exactly those actions (NOT terraform-deployer, which is over-privileged).
# The old account's manually-created CI user was lost in the greenfield restart;
# this re-creates it as code. Access key is surfaced as a sensitive root output to
# paste into GitHub → Settings → Environments → aws-production secrets.
# =============================================================================

resource "aws_iam_user" "github_actions" {
  name = "${var.project_name}-github-actions"

  tags = {
    Project = var.project_name
    Purpose = "ci-cd-deploy"
  }
}

resource "aws_iam_access_key" "github_actions" {
  user = aws_iam_user.github_actions.name
}

# --- ECR push: authenticate + push image (build-and-push job) ---
resource "aws_iam_user_policy" "github_actions_ecr_push" {
  name = "${var.project_name}-gha-ecr-push"
  user = aws_iam_user.github_actions.name

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
resource "aws_iam_user_policy" "github_actions_asg_refresh" {
  name = "${var.project_name}-gha-asg-refresh"
  user = aws_iam_user.github_actions.name

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
      }
    ]
  })
}
