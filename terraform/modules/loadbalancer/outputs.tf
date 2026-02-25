# Load Balancer Module — Outputs

output "nlb_dns_name" {
  value = aws_lb.main.dns_name
}

output "nlb_arn" {
  value = aws_lb.main.arn
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}
