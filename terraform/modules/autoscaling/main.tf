# =============================================================================
# Auto Scaling Module — Launch Template + ASG + Scaling Policies
# =============================================================================
# Replaces the standalone EC2 compute module with:
#   - Launch Template (same config as compute: AMI, user-data, SG, IAM)
#   - Auto Scaling Group (1-N instances per region)
#   - Target tracking scaling policy (based on custom ActiveConnections metric)
#   - Lifecycle hooks for graceful launch/terminate
# =============================================================================

# --- Get latest Ubuntu 24.04 AMI ---
data "aws_ami" "ubuntu" {
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

# --- SSH Key Pair ---
resource "aws_key_pair" "deploy" {
  key_name   = "${var.project_name}-asg-deploy-key"
  public_key = file(var.ssh_public_key_path)

  tags = {
    Project = var.project_name
  }
}

# --- Launch Template ---
resource "aws_launch_template" "msab" {
  name_prefix   = "${var.project_name}-lt-"
  image_id      = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  key_name      = aws_key_pair.deploy.key_name

  # IAM instance profile (CloudWatch + ASG lifecycle permissions)
  iam_instance_profile {
    name = var.instance_profile_name
  }

  # Network — place in the first public subnet's VPC
  vpc_security_group_ids = [var.msab_security_group_id]

  # Detailed monitoring for CloudWatch
  monitoring {
    enabled = true
  }

  # Root volume
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = 30
      encrypted             = true
      delete_on_termination = true
    }
  }

  # User data script — same as compute module
  user_data = base64encode(templatefile("${path.module}/user-data.sh", {
    region               = var.region
    project_name         = var.project_name
    github_repo          = var.github_repo
    github_branch        = var.github_branch
    app_port             = var.app_port
    rtc_min_port         = var.rtc_min_port
    rtc_max_port         = var.rtc_max_port
    redis_host           = var.redis_host
    redis_port           = var.redis_port
    redis_password       = var.redis_password
    laravel_internal_key = var.laravel_internal_key
    jwt_secret           = var.jwt_secret
    session_secret       = var.session_secret
    audio_domain         = var.audio_domain
    cors_origins         = var.cors_origins
    laravel_api_url      = var.laravel_api_url
    cascade_enabled      = var.cascade_enabled
  }))

  # Metadata options (IMDSv2 required)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name    = "${var.project_name}-asg-instance"
      Project = var.project_name
      Role    = "msab"
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Project = var.project_name
  }
}

# --- Auto Scaling Group ---
resource "aws_autoscaling_group" "msab" {
  name_prefix         = "${var.project_name}-asg-"
  min_size            = var.min_instances
  max_size            = var.max_instances
  desired_capacity    = var.desired_instances
  vpc_zone_identifier = var.public_subnet_ids

  # Register instances with NLB target group
  target_group_arns = [var.target_group_arn]

  # Health check via NLB target group
  health_check_type         = "ELB"
  health_check_grace_period = 300 # 5 min for user-data to complete

  # Use latest launch template version
  launch_template {
    id      = aws_launch_template.msab.id
    version = "$Latest"
  }

  # Instance refresh settings (for rolling deployments)
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 300
    }
  }

  # Tags propagated to instances
  tag {
    key                 = "Project"
    value               = var.project_name
    propagate_at_launch = true
  }

  tag {
    key                 = "ManagedBy"
    value               = "terraform-asg"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Lifecycle Hook: Launching ---
# Gives instances time to complete user-data bootstrap before receiving traffic
resource "aws_autoscaling_lifecycle_hook" "launching" {
  name                   = "msab-launch-hook"
  autoscaling_group_name = aws_autoscaling_group.msab.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_LAUNCHING"
  heartbeat_timeout      = 300 # 5 minutes for bootstrap
  default_result         = "CONTINUE"
}

# --- Lifecycle Hook: Terminating ---
# Gives MSAB time to drain WebRTC rooms before termination
resource "aws_autoscaling_lifecycle_hook" "terminating" {
  name                   = "msab-terminate-hook"
  autoscaling_group_name = aws_autoscaling_group.msab.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_TERMINATING"
  heartbeat_timeout      = var.drain_timeout_seconds
  default_result         = "CONTINUE" # Terminate even if drain fails
}

# --- Scaling Policy: Scale Up ---
resource "aws_autoscaling_policy" "scale_up" {
  name                   = "${var.project_name}-scale-up"
  autoscaling_group_name = aws_autoscaling_group.msab.name
  policy_type            = "StepScaling"
  adjustment_type        = "ChangeInCapacity"

  step_adjustment {
    scaling_adjustment          = 1
    metric_interval_lower_bound = 0
  }
}

# --- Scaling Policy: Scale Down ---
resource "aws_autoscaling_policy" "scale_down" {
  name                   = "${var.project_name}-scale-down"
  autoscaling_group_name = aws_autoscaling_group.msab.name
  policy_type            = "StepScaling"
  adjustment_type        = "ChangeInCapacity"

  step_adjustment {
    scaling_adjustment          = -1
    metric_interval_upper_bound = 0
  }
}

# --- CloudWatch Alarm: High Connections (triggers scale up) ---
resource "aws_cloudwatch_metric_alarm" "high_connections" {
  alarm_name          = "${var.project_name}-high-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ActiveConnections"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Average"
  threshold           = var.scale_up_threshold
  alarm_description   = "Scale up when ActiveConnections > ${var.scale_up_threshold} for 3 minutes"

  alarm_actions = [aws_autoscaling_policy.scale_up.arn]

  dimensions = {}
  # Note: No InstanceId dimension — we want the aggregate across all instances in the ASG
  # CloudWatch will aggregate across all instances publishing to FlyLive/MSAB
}

# --- CloudWatch Alarm: Low Connections (triggers scale down) ---
resource "aws_cloudwatch_metric_alarm" "low_connections" {
  alarm_name          = "${var.project_name}-low-connections"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 10
  metric_name         = "ActiveConnections"
  namespace           = "FlyLive/MSAB"
  period              = 60
  statistic           = "Average"
  threshold           = var.scale_down_threshold
  alarm_description   = "Scale down when ActiveConnections < ${var.scale_down_threshold} for 10 minutes"

  alarm_actions = [aws_autoscaling_policy.scale_down.arn]

  dimensions = {}
}
