# Auto Scaling Module — Outputs

output "asg_name" {
  description = "Auto Scaling Group name"
  value       = aws_autoscaling_group.msab.name
}

output "asg_arn" {
  description = "Auto Scaling Group ARN"
  value       = aws_autoscaling_group.msab.arn
}

output "launch_template_id" {
  description = "Launch Template ID"
  value       = aws_launch_template.msab.id
}

output "launch_template_version" {
  description = "Latest Launch Template version"
  value       = aws_launch_template.msab.latest_version
}
