output "host" {
  value = vultr_database.main.host
}

output "port" {
  value = vultr_database.main.port
}

output "password" {
  value     = vultr_database.main.password
  sensitive = true
}

output "ca_certificate" {
  value     = vultr_database.main.ca_certificate
  sensitive = true
}
