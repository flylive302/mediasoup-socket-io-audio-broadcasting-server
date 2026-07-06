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
