# =============================================================================
# Load Balancer Module — NLB for TCP/UDP
# =============================================================================
# Ticket 23 — two Vultr-era workarounds are DELIBERATELY NOT PORTED. Do not
# reimplement either here:
#
# 1. Instance-ID reattachment (old rolling-deploy.sh:120-159): Vultr's LB
#    attached instances BY ID, so a `-replace` orphaned the LB fleet-wide until
#    a raw provider API call re-attached them (live outage 2026-07-09). AWS
#    target groups track registration, not instance identity, and the ASG
#    registers/deregisters instances itself (`target_group_arns` on the ASG in
#    modules/autoscaling). No deploy script may ever call a load-balancer API
#    (aws elbv2 register-targets / deregister-targets) — if you think you need
#    to, the ASG wiring is broken; fix that instead.
#
# 2. Fee-cap retry loop (old rolling-deploy.sh:94-118, 3 retries × 120 s):
#    existed only because a destroy kept counting against Vultr's monthly
#    spend cap for several minutes. AWS has no equivalent cap; the loop has
#    no reason to exist.
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

  # Ticket 23: every health-check knob set explicitly — no implicit AWS
  # defaults. HTTP against the app's own /health, matching the ASG's
  # "ELB" health_check_type and the derived grace window in autoscaling.
  health_check {
    enabled             = true
    protocol            = "HTTP"
    port                = tostring(var.app_port)
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 10
  }

  # Stickiness stays DISABLED — deliberately, for two reasons:
  #
  # 1. Session affinity is NOT the load balancer's job on this platform.
  #    Room→instance affinity comes from epic 3a's room pinning: a client is
  #    directed to the specific instance its room is pinned to, so LB-level
  #    stickiness adds nothing to correctness. WebRTC media is UDP straight to
  #    the instance and never crosses the NLB; only signaling TCP does.
  # 2. TIER0 (F-85), from the Global-Accelerator era (GA since removed):
  #    source_ip stickiness collapsed new connections onto whichever instance
  #    the small set of edge IPs hashed to — one box soaked all traffic while
  #    the rest idled. Flow-hash distribution is what we want.
  #
  # INFRASTRUCTURE.md's claim that stickiness is enabled and "critical for
  # WebSocket connections" is WRONG (doc-supersession list, epic 1 ticket 13).
  stickiness {
    enabled = false
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

# Ticket 23: target-group registration is ENTIRELY ASG-managed
# (attach-on-launch, deregister-on-terminate via `target_group_arns` on the
# ASG). The former `aws_lb_target_group_attachment` + `instance_id` escape
# hatch was removed — it was the old provider's attach-by-instance-ID pattern
# (see the module header) and inviting it back defeats the point of the move.
