variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "valkey_plan" {
  description = "Vultr managed-database plan ID. Default is the cheapest 2-node (HA: primary + standby) Valkey-capable plan — required because cascade CAS ownership depends on this being a single always-up shared endpoint per region."
  type        = string
  default     = "vultr-dbaas-business-rp-intel-1-12-2"
}

variable "valkey_version" {
  description = "Valkey engine version. Vultr's \"Deploy Database\" dashboard offers 8.1-9.0 and defaults to 9.0 (confirmed live 2026-07-06)."
  type        = string
  default     = "9.0"
}
