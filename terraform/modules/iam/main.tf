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
