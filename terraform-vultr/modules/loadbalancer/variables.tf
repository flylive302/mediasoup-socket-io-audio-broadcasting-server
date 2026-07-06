variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "app_port" {
  type = number
}

variable "instance_ids" {
  description = "Instance IDs to attach to the load balancer."
  type        = list(string)
}

variable "vpc_id" {
  description = "Shared private network (VPC) ID the LB uses to reach its backend instances. Must match the instance's VPC. Empty = none (LB cannot reach backends → never serves)."
  type        = string
  default     = ""
}

variable "hostname" {
  description = "The per-region public hostname this load balancer serves (e.g. bom.audio.flyliveapp.com). Informational only now (Vultr's auto_ssl_domain isn't usable — it requires the domain to be a Vultr-hosted DNS zone in this account, which conflicts with keeping Cloudflare as DNS authority). See ssl_certificate/ssl_private_key."
  type        = string
}

# --- TLS certificate (Cloudflare Origin CA, brought in rather than Vultr auto_ssl_domain) ---
# Origin CA certs are only trusted by Cloudflare's edge, not public browsers directly —
# so the Cloudflare DNS record for `hostname` MUST be PROXIED (orange-cloud), not
# DNS-only. That's fine here: raw WebRTC media/cascade already bypass this hostname
# entirely (they go straight to the instance's reserved public IP), so proxying only
# the signaling/WSS hostname through Cloudflare is safe (and hides the origin IP).

variable "ssl_certificate" {
  description = "PEM certificate (Cloudflare Origin CA, or any cert trusted for `hostname`)."
  type        = string
  sensitive   = true
}

variable "ssl_private_key" {
  description = "PEM private key matching ssl_certificate."
  type        = string
  sensitive   = true
}

variable "ssl_chain" {
  description = "Optional PEM certificate chain."
  type        = string
  sensitive   = true
  default     = ""
}

# --- Frontend firewall (source allow-list for the LB's 443 listener) ---
# Vultr LB firewall_rules RESTRICT inbound to the listed sources. When empty, the
# LB is open to all. For a Cloudflare-proxied setup the production value should be
# a single { source = "cloudflare" } rule so only Cloudflare's edge can reach the
# origin LB (hides the origin, blocks direct-to-LB scans). `source` is either an
# IPv4/IPv6 address (paired with subnet_size) or the literal "cloudflare".
variable "allowed_sources" {
  description = "Frontend firewall allow-list for port 443. Empty = open to all. Each entry: source ('cloudflare' or a CIDR like 0.0.0.0/0) and ip_type (v4/v6)."
  type = list(object({
    source  = string
    ip_type = string
  }))
  default = []
}
