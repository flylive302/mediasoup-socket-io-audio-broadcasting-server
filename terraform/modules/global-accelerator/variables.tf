# Global Accelerator Module — Variables

variable "project_name" {
  type = string
}

variable "regional_endpoints" {
  description = "Map of region => { nlb_arn } for endpoint groups"
  type = map(object({
    nlb_arn = string
  }))
}
