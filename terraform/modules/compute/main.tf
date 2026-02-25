# =============================================================================
# Compute Module — EC2 Instance for MediaSoup
# =============================================================================

# --- SSH Key Pair ---
resource "aws_key_pair" "deploy" {
  key_name   = "${var.project_name}-deploy-key"
  public_key = file(var.ssh_public_key_path)

  tags = {
    Project = var.project_name
  }
}

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

# --- Elastic IP (stable announcedIp for MediaSoup) ---
resource "aws_eip" "msab" {
  domain = "vpc"

  tags = {
    Name    = "${var.project_name}-eip"
    Project = var.project_name
  }
}

# --- EC2 Instance ---
resource "aws_instance" "msab" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.deploy.key_name
  subnet_id              = var.public_subnet_id
  vpc_security_group_ids = [var.msab_security_group_id]

  # Enable detailed monitoring for CloudWatch
  monitoring = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/user-data.sh", {
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
  })

  tags = {
    Name    = "${var.project_name}-server-1"
    Project = var.project_name
    Role    = "msab"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

# --- Associate Elastic IP ---
resource "aws_eip_association" "msab" {
  instance_id   = aws_instance.msab.id
  allocation_id = aws_eip.msab.id
}
