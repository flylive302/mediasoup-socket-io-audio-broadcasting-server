# SSL Module — Variables

variable "project_name" {
  type = string
}

variable "audio_domain" {
  type = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for audio_domain's zone — used to create ACM DNS validation records and to read CAA records for the pre-issuance check"
  type        = string
}

variable "caa_records_override" {
  description = <<-EOT
    TEST SEAM — substitutes the live Cloudflare CAA lookup in offline
    terraform tests, where the provider's nested `cloudflare_dns_records`
    result schema cannot be mocked (mock_data/override_data both fail to
    convert its list(object) result attribute). null = query Cloudflare (the
    production path — this is the default everywhere outside tests). Never
    set this outside tests.
  EOT
  type        = list(object({
    tag   = string
    value = string
  }))
  default = null
}
