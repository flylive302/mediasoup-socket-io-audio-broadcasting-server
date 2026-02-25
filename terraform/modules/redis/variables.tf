# Redis Module — Variables

variable "project_name" {
  type = string
}

variable "redis_node_type" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "redis_security_group_id" {
  type = string
}
