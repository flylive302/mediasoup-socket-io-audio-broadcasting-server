# SSL Module — Outputs

output "certificate_arn" {
  # Use the validation resource's ARN to create an implicit dependency:
  # downstream resources (NLB listener) won't use this ARN until validation completes.
  value = aws_acm_certificate_validation.main.certificate_arn
}

output "domain_validation_options" {
  value = aws_acm_certificate.main.domain_validation_options
}
