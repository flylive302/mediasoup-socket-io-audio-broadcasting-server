# Networking Module — Outputs

output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "msab_security_group_id" {
  value = aws_security_group.msab.id
}

output "redis_security_group_id" {
  value = aws_security_group.redis.id
}
