variable "folder_id" {
  type        = string
  description = "Yandex Cloud Folder ID"
}

variable "cloud_id" {
  type        = string
  description = "Yandex Cloud ID"
  default     = ""
}

variable "zone" {
  type        = string
  description = "Yandex Cloud availability zone"
  default     = "ru-central1-a"
}

variable "vk_group_id" {
  type        = number
  description = "VK Community ID"
}

variable "webhook_image_tag" {
  type        = string
  description = "Container image tag for webhook"
  default     = "latest"
}

variable "worker_image_tag" {
  type        = string
  description = "Container image tag for worker"
  default     = "v13"
}

variable "service_account_key_file" {
  type        = string
  description = "Path to the service account key JSON file downloaded from the Yandex Cloud web console"
  default     = null
}

variable "app_version" {
  type        = string
  description = "Application version string"
  default     = "1.0.0"
}



variable "github_repository" {
  type        = string
  description = "Repository receiving runtime bug issues (owner/repository)"
  default     = "artemu78/page_parcel"
  validation {
    condition     = can(regex("^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be owner/repository."
  }
}
