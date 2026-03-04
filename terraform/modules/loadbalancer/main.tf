# =============================================================================
# Load Balancer Module — NLB for TCP/UDP
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# --- Network Load Balancer ---
resource "aws_lb" "main" {
  name               = "${var.project_name}-nlb"
  internal           = false
  load_balancer_type = "network"
  subnets            = var.public_subnet_ids

  enable_cross_zone_load_balancing = true

  tags = {
    Name    = "${var.project_name}-nlb"
    Project = var.project_name
  }
}

# --- Target Group: TCP (WebSocket/HTTP) ---
resource "aws_lb_target_group" "app" {
  name        = "${var.project_name}-app-tg"
  port        = var.app_port
  protocol    = "TCP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled             = true
    protocol            = "HTTP"
    port                = tostring(var.app_port)
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }

  stickiness {
    enabled = true
    type    = "source_ip"
  }

  tags = {
    Project = var.project_name
  }
}

# --- Listener: TCP app port (direct, non-SSL) ---
resource "aws_lb_listener" "app" {
  load_balancer_arn = aws_lb.main.arn
  port              = var.app_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# --- Listener: TLS on port 443 (SSL termination) ---
resource "aws_lb_listener" "tls" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "TLS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# --- Register EC2 instance (only for standalone EC2, not when using ASG) ---
resource "aws_lb_target_group_attachment" "msab" {
  count            = var.instance_id != "" ? 1 : 0
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = var.instance_id
  port             = var.app_port
}
