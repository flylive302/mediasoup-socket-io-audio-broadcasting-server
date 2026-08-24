# =============================================================================
# Networking Module — VPC, Subnets, Security Groups
# =============================================================================

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  # Ticket 31 / decision D3: every runtime resource NAME is qualified by the
  # environment so staging and production can coexist in AWS account
  # 505307260926 (ADR 0028). Deterministic from var.environment — full token,
  # no abbreviation map (all names verified inside AWS length limits).
  # TAGS keep using var.project_name; only NAMES take the prefix.
  env_prefix = "${var.project_name}-${var.environment}"
}

data "aws_availability_zones" "available" {
  state = "available"
}

# --- VPC ---
resource "aws_vpc" "main" {
  # CIDR comes from the ticket-11 allocation table — non-overlapping per
  # region+environment so future peering/transit never needs renumbering.
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name    = "${local.env_prefix}-vpc"
    Project = var.project_name
  }
}

# --- Internet Gateway ---
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name    = "${local.env_prefix}-igw"
    Project = var.project_name
  }
}

# --- Public Subnets (2 AZs for NLB requirement) ---
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name    = "${local.env_prefix}-public-${count.index + 1}"
    Project = var.project_name
  }
}

# --- Private Subnets (for ElastiCache) ---
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name    = "${local.env_prefix}-private-${count.index + 1}"
    Project = var.project_name
  }
}

# --- Route Table (public) ---
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name    = "${local.env_prefix}-public-rt"
    Project = var.project_name
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- Security Group: MSAB Server ---
resource "aws_security_group" "msab" {
  name_prefix = "${local.env_prefix}-msab-"
  description = "Security group for MediaSoup audio server"
  vpc_id      = aws_vpc.main.id

  # SSH removed — use SSM Session Manager for shell access (no port 22 exposure)

  # Application HTTP/WebSocket
  ingress {
    description = "App HTTP/WS"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Per-instance TLS termination (ticket 39 — AWS port of MSAB issue 36). The
  # instance's local nginx terminator (modules/autoscaling/user-data.sh) listens
  # :443 with the Cloudflare Origin CA cert fetched from SSM, so a per-instance
  # DNS record (ticket 39's DNS half, same manage_instance_dns gate) can
  # complete a Full(strict) handshake straight to the instance. Same
  # permissiveness as the app rule above — world-open, matching the Vultr
  # analogue (vultr_firewall_rule.tls_tcp) exactly. Cloudflare-only tightening
  # (source = Cloudflare's published edge IP ranges) is a noted follow-up, not
  # a blocker — deliberately NOT inherited silently, called out explicitly here
  # per ticket 39 AC.
  dynamic "ingress" {
    for_each = var.manage_instance_dns ? [1] : []
    content {
      description = "Per-instance TLS termination (ticket 39)"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # WebRTC — deliberately NARROW (ticket 11). The app binds one shared port per
  # mediasoup worker (WebRtcServer: rtc_min_port + worker index, same number on
  # UDP and TCP); it does NOT allocate a port per user. 64 ports covers a
  # 32-vCPU instance with headroom. The app crashes loudly if WebRtcServer
  # creation ever fails (worker.manager.ts) so the old silent per-transport
  # fallback can never bind ports this firewall blocks.
  ingress {
    description = "WebRTC UDP (one shared port per worker)"
    from_port   = var.rtc_min_port
    to_port     = var.rtc_max_port
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "WebRTC TCP fallback (same per-worker ports)"
    from_port   = var.rtc_min_port
    to_port     = var.rtc_max_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SFU cascade relay (plainTransport 40000-49999, UDP only). NOT dormant at
  # single-region: cascade also pipes audio between two instances in the SAME
  # region when a room spans them (cross-region-join.ts "same-region edge"),
  # and it announces instance PUBLIC IPs — traffic hairpins through the IGW and
  # arrives internet-sourced, so a security-group source reference cannot match.
  # Gated: close via cascade_ports_open=false once affinity replaces cascade.
  dynamic "ingress" {
    for_each = var.cascade_ports_open ? [1] : []
    content {
      description = "SFU cascade relay UDP (instance public IPs; see cascade_ports_open)"
      from_port   = var.cascade_relay_min_port
      to_port     = var.cascade_relay_max_port
      protocol    = "udp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # node_exporter scrape, from the loadgen box ONLY (aws-production/08). Source
  # is a SECURITY GROUP, never a CIDR — the whole point is that nothing except
  # the loadgen box's own SG can reach this port. INLINE dynamic block, same
  # as the cascade rule above: this SG already mixes plain + dynamic inline
  # ingress blocks, and adding a separate aws_security_group_rule /
  # aws_vpc_security_group_ingress_rule resource on the SAME security group
  # would fight Terraform's inline-block reconciliation and delete rules out
  # from under itself. for_each is gated on the STATIC loadgen_ingress_enabled
  # bool, not on loadgen_security_group_id being non-empty — see that
  # variable's comment for why (unknown-value for_each).
  dynamic "ingress" {
    for_each = var.loadgen_ingress_enabled ? [1] : []
    content {
      description     = "node_exporter scrape from the loadgen box (aws-production/08)"
      from_port       = 9100
      to_port         = 9100
      protocol        = "tcp"
      security_groups = [var.loadgen_security_group_id]
    }
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${local.env_prefix}-msab-sg"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Security Group: Redis (only from MSAB) ---
resource "aws_security_group" "redis" {
  name_prefix = "${local.env_prefix}-redis-"
  description = "Security group for ElastiCache Redis"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from MSAB"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.msab.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${local.env_prefix}-redis-sg"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}
