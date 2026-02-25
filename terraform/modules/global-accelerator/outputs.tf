# Global Accelerator Module — Outputs

output "dns_name" {
  description = "Global Accelerator DNS name (point audio.flyliveapp.com here)"
  value       = aws_globalaccelerator_accelerator.main.dns_name
}

output "ip_addresses" {
  description = "Anycast IP addresses"
  value       = [for attr in aws_globalaccelerator_accelerator.main.ip_sets : attr.ip_addresses]
}

output "accelerator_arn" {
  value = aws_globalaccelerator_accelerator.main.id
}
