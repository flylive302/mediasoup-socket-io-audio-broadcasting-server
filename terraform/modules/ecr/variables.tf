# ECR Module — Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "replication_destination_regions" {
  description = "Regions to replicate ECR images into (besides this module's own region). Each consuming region should appear here so instances pull from a local registry. Empty = no replication."
  type        = list(string)
  default     = []
}
