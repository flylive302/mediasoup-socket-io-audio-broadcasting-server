# Networking Module — Variables

variable "project_name" {
  type = string
}

variable "environment" {
  description = "Deployment environment (staging|production). Qualifies every resource NAME in this module so both environments can coexist in one AWS account (ADR 0028, ticket 31 / decision D3)."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR — from the ticket-11 allocation table (docs/issues/aws-platform-build/11-CIDR-ALLOCATION.md). Non-overlapping per region+environment; ONE-WAY once addresses are in use."
  type        = string
}

variable "app_port" {
  type = number
}

variable "rtc_min_port" {
  description = "First WebRTC port. The app binds ONE shared port per mediasoup worker (rtc_min_port + worker index, UDP+TCP) via WebRtcServer — NOT one port per user."
  type        = number
}

variable "rtc_max_port" {
  description = "Last WebRTC port opened in the firewall. Sized as headroom over worker count (workers = vCPU - 1), not per-connection."
  type        = number
}

variable "cascade_ports_open" {
  description = <<-EOT
    Open the SFU cascade relay UDP range (40000-49999) to the internet.
    Required while CASCADE_ENABLED=true: cascade pipes audio between instances
    (including two instances in the SAME region when a room spans them) using
    instance PUBLIC IPs, so the traffic arrives internet-sourced and cannot be
    security-group-referenced. Close only once room affinity (affinity epic
    07/09/11) guarantees single-instance rooms AND multi-region is off.
  EOT
  type        = bool
}

variable "cascade_relay_min_port" {
  description = "Cascade plainTransport range start — must match PLAIN_TRANSPORT_MIN_PORT in src/domains/media/pipe-manager.ts"
  type        = number
  default     = 40000
}

variable "cascade_relay_max_port" {
  description = "Cascade plainTransport range end — must match PLAIN_TRANSPORT_MAX_PORT in src/domains/media/pipe-manager.ts"
  type        = number
  default     = 49999
}

# --- Loadgen scrape access (aws-production/08) ---
# TWO variables, deliberately not one. Gating the dynamic ingress block below
# on `loadgen_security_group_id != ""` looks natural but is WRONG: when
# loadgen is enabled that id is aws_security_group.loadgen[0].id — a computed
# attribute, unknown at plan time — and a for_each expression can never depend
# on an unknown value (Terraform error: "Invalid for_each argument"). This
# repo already hit exactly this class of bug; see modules/iam/main.tf's
# aws_iam_role_policy.sqs_consume comment ("Gated on a static flag, not on the
# ARN being non-empty — the ARN is computed"). So: a STATIC bool gates
# for_each, and the (possibly-unknown-at-plan) id is used only as the rule's
# `security_groups` value, where an unknown attribute is completely normal.
variable "loadgen_ingress_enabled" {
  description = "Static (plan-known) flag that gates the msab security group's port-9100 ingress-from-loadgen rule. Must be computed from root variables only (e.g. var.loadgen_enabled && var.environment == \"staging\") — never from the loadgen module's own output, which is unknown at plan time whenever this would be true. Default false keeps every existing caller (frankfurt/singapore, any test that doesn't pass it) unaffected."
  type        = bool
  default     = false
}

variable "loadgen_security_group_id" {
  description = "The loadgen module's security group id — used only as the ingress rule's source (security_groups), never in a for_each/count expression (see loadgen_ingress_enabled). Default \"\" — harmless when loadgen_ingress_enabled is false, since the dynamic block's for_each is empty and this value is never read."
  type        = string
  default     = ""
}

variable "manage_instance_dns" {
  description = "Gates the msab security group's 443 ingress rule (per-instance TLS terminator, ticket 39) — same var that gates the per-instance DNS record itself, so the record and the port that answers it ship/flip together. Default false = no 443 rule at all."
  type        = bool
  default     = false
}
