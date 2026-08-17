# SSM Module — Outputs

output "kms_key_arn" {
  description = "ARN of the customer-managed KMS key encrypting this region's SSM SecureString parameters"
  value       = aws_kms_key.ssm.arn
}

output "kms_key_id" {
  description = "Key ID of the customer-managed KMS key encrypting this region's SSM SecureString parameters"
  value       = aws_kms_key.ssm.key_id
}

output "kms_alias_name" {
  description = "Alias of the customer-managed KMS key"
  value       = aws_kms_alias.ssm.name
}

# Map keyed by logical secret name -> SSM parameter name/ARN. The HLS R2 keys
# are conditionally created (var.broadcast_hls_enabled), and jwt_secret_previous
# only exists during a rotation, so all of them are included via a merge rather
# than unconditional references that would fail when the count is 0.
output "parameter_names" {
  description = "Map of logical secret name to its SSM parameter name"
  value = merge(
    {
      jwt_secret              = aws_ssm_parameter.jwt_secret.name
      laravel_internal_key    = aws_ssm_parameter.laravel_internal_key.name
      session_secret          = aws_ssm_parameter.session_secret.name
      cloudflare_turn_api_key = aws_ssm_parameter.cloudflare_turn_api_key.name
      redis_auth_token        = aws_ssm_parameter.redis_auth_token.name
    },
    length(aws_ssm_parameter.jwt_secret_previous) > 0 ? {
      jwt_secret_previous = aws_ssm_parameter.jwt_secret_previous[0].name
    } : {},
    var.broadcast_hls_enabled ? {
      hls_r2_access_key_id     = aws_ssm_parameter.hls_r2_access_key_id[0].name
      hls_r2_secret_access_key = aws_ssm_parameter.hls_r2_secret_access_key[0].name
    } : {}
  )
}

output "parameter_arns" {
  description = "Map of logical secret name to its SSM parameter ARN"
  value = merge(
    {
      jwt_secret              = aws_ssm_parameter.jwt_secret.arn
      laravel_internal_key    = aws_ssm_parameter.laravel_internal_key.arn
      session_secret          = aws_ssm_parameter.session_secret.arn
      cloudflare_turn_api_key = aws_ssm_parameter.cloudflare_turn_api_key.arn
      redis_auth_token        = aws_ssm_parameter.redis_auth_token.arn
    },
    length(aws_ssm_parameter.jwt_secret_previous) > 0 ? {
      jwt_secret_previous = aws_ssm_parameter.jwt_secret_previous[0].arn
    } : {},
    var.broadcast_hls_enabled ? {
      hls_r2_access_key_id     = aws_ssm_parameter.hls_r2_access_key_id[0].arn
      hls_r2_secret_access_key = aws_ssm_parameter.hls_r2_secret_access_key[0].arn
    } : {}
  )
}
