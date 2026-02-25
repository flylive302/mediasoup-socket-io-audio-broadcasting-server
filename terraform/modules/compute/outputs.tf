# Compute Module — Outputs

output "instance_id" {
  value = aws_instance.msab.id
}

output "instance_private_ip" {
  value = aws_instance.msab.private_ip
}

output "elastic_ip" {
  value = aws_eip.msab.public_ip
}

output "key_pair_name" {
  value = aws_key_pair.deploy.key_name
}
