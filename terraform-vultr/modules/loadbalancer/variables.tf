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
  description = "The per-region public hostname this load balancer serves (e.g. bom.audio.staging.flyliveapp.com). DNS (Cloudflare, DNS-only / grey-cloud — proxying would break the ACME HTTP-01 challenge and isn't compatible with the raw TCP/UDP media path anyway) is wired up manually per A-vultr-dashboard-walkthrough.md; Vultr auto-issues the Let's Encrypt cert once that record resolves here."
  type        = string
}
