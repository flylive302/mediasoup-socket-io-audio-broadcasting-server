output "firewall_group_id" {
  value = vultr_firewall_group.msab.id
}

output "vpc_id" {
  value = vultr_vpc.msab.id
}
