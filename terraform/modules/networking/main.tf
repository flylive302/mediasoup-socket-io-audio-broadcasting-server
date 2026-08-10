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
    Name    = "${var.project_name}-vpc"
    Project = var.project_name
  }
}

# --- Internet Gateway ---
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name    = "${var.project_name}-igw"
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
    Name    = "${var.project_name}-public-${count.index + 1}"
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
    Name    = "${var.project_name}-private-${count.index + 1}"
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
    Name    = "${var.project_name}-public-rt"
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
  name_prefix = "${var.project_name}-msab-"
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

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-msab-sg"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Security Group: Redis (only from MSAB) ---
resource "aws_security_group" "redis" {
  name_prefix = "${var.project_name}-redis-"
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
    Name    = "${var.project_name}-redis-sg"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}
