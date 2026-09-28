terraform {
  required_version = ">= 1.5.0"
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = ">= 0.100.0"
    }
  }
}

provider "yandex" {
  folder_id                = var.folder_id
  zone                     = var.zone
  service_account_key_file = var.service_account_key_file
}

# 1. Container Registry
resource "yandex_container_registry" "registry" {
  name      = "readable-web-registry"
  folder_id = var.folder_id
}

# 2. Service Accounts & Least-Privilege IAM Roles
resource "yandex_iam_service_account" "webhook_sa" {
  name        = "readable-web-webhook-sa"
  description = "Service account for Webhook Serverless Container and YMQ access"
}

resource "yandex_iam_service_account" "worker_sa" {
  name        = "readable-web-worker-sa"
  description = "Service account for Worker Service"
}

resource "yandex_iam_service_account" "trigger_sa" {
  name        = "readable-web-trigger-sa"
  description = "Service account for YMQ Trigger"
}

# Grant YMQ admin to webhook SA (allows creating/configuring queues and writing messages)
resource "yandex_resourcemanager_folder_iam_member" "webhook_ymq_admin" {
  folder_id = var.folder_id
  role      = "ymq.admin"
  member    = "serviceAccount:${yandex_iam_service_account.webhook_sa.id}"
}

# Grant YDB editor to both SAs
resource "yandex_resourcemanager_folder_iam_member" "webhook_ydb_editor" {
  folder_id = var.folder_id
  role      = "ydb.editor"
  member    = "serviceAccount:${yandex_iam_service_account.webhook_sa.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "worker_ydb_editor" {
  folder_id = var.folder_id
  role      = "ydb.editor"
  member    = "serviceAccount:${yandex_iam_service_account.worker_sa.id}"
}

# Grant Container Registry Puller to webhook and worker SAs
resource "yandex_resourcemanager_folder_iam_member" "webhook_cr_puller" {
  folder_id = var.folder_id
  role      = "container-registry.images.puller"
  member    = "serviceAccount:${yandex_iam_service_account.webhook_sa.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "worker_cr_puller" {
  folder_id = var.folder_id
  role      = "container-registry.images.puller"
  member    = "serviceAccount:${yandex_iam_service_account.worker_sa.id}"
}

# Grant Trigger SA permissions to invoke Serverless Container
resource "yandex_resourcemanager_folder_iam_member" "trigger_invoker" {
  folder_id = var.folder_id
  role      = "serverless.containers.invoker"
  member    = "serviceAccount:${yandex_iam_service_account.trigger_sa.id}"
}

# Grant Trigger SA permissions to read from YMQ
resource "yandex_resourcemanager_folder_iam_member" "trigger_ymq_reader" {
  folder_id = var.folder_id
  role      = "ymq.reader"
  member    = "serviceAccount:${yandex_iam_service_account.trigger_sa.id}"
}

# Static Access Key for Webhook SA (Required for YMQ SQS-compatible API)
resource "yandex_iam_service_account_static_access_key" "ymq_key" {
  service_account_id = yandex_iam_service_account.webhook_sa.id
  description        = "Static access key for YMQ operations"
}

# 3. Yandex Lockbox Secrets
resource "yandex_lockbox_secret" "vk_secrets" {
  name        = "readable-web-vk-secrets"
  description = "VK Community token, secret, and confirmation code"
  folder_id   = var.folder_id
}

# Read active version dynamically from Lockbox
data "yandex_lockbox_secret" "vk_secrets" {
  secret_id = yandex_lockbox_secret.vk_secrets.id
}

# Grant payload viewer to SAs
resource "yandex_resourcemanager_folder_iam_member" "webhook_lockbox" {
  folder_id = var.folder_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.webhook_sa.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "worker_lockbox" {
  folder_id = var.folder_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.worker_sa.id}"
}

# 4. YDB Serverless Database
resource "yandex_ydb_database_serverless" "db" {
  name      = "readable-web-ydb"
  folder_id = var.folder_id
}

# 5. Yandex Message Queue (YMQ) & Dead Letter Queue (DLQ)
resource "yandex_message_queue" "dlq" {
  name                      = "readable-web-dlq"
  access_key                = yandex_iam_service_account_static_access_key.ymq_key.access_key
  secret_key                = yandex_iam_service_account_static_access_key.ymq_key.secret_key
  message_retention_seconds = 1209600 # 14 days

  depends_on = [
    yandex_resourcemanager_folder_iam_member.webhook_ymq_admin,
    yandex_iam_service_account_static_access_key.ymq_key
  ]
}

resource "yandex_message_queue" "jobs_queue" {
  name                       = "readable-web-jobs"
  access_key                 = yandex_iam_service_account_static_access_key.ymq_key.access_key
  secret_key                 = yandex_iam_service_account_static_access_key.ymq_key.secret_key
  visibility_timeout_seconds = 150   # Covers maximum 120s worker job deadline + startup buffer
  message_retention_seconds  = 86400 # 24 hours
  redrive_policy = jsonencode({
    deadLetterTargetArn = yandex_message_queue.dlq.arn
    maxReceiveCount     = 3
  })

  depends_on = [
    yandex_resourcemanager_folder_iam_member.webhook_ymq_admin,
    yandex_message_queue.dlq
  ]
}

# 6. Webhook Serverless Container (Public Ingress)
resource "yandex_serverless_container" "webhook" {
  name               = "readable-web-webhook"
  folder_id          = var.folder_id
  memory             = 512
  cores              = 1
  core_fraction      = 100
  execution_timeout  = "15s"
  service_account_id = yandex_iam_service_account.webhook_sa.id

  metadata_options {
    gce_http_endpoint = 1
  }

  image {
    url = "cr.yandex/${yandex_container_registry.registry.id}/webhook:${var.webhook_image_tag}"
    environment = {
      NODE_ENV                 = "production"
      APP_VERSION              = "7"
      VK_GROUP_ID              = tostring(var.vk_group_id)
      YMQ_QUEUE_URL            = yandex_message_queue.jobs_queue.id
      YMQ_ACCESS_KEY           = yandex_iam_service_account_static_access_key.ymq_key.access_key
      YMQ_SECRET_KEY           = yandex_iam_service_account_static_access_key.ymq_key.secret_key
      YDB_ENDPOINT             = yandex_ydb_database_serverless.db.ydb_api_endpoint
      YDB_DATABASE             = yandex_ydb_database_serverless.db.database_path
      YDB_METADATA_CREDENTIALS = "1"
    }
  }

  secrets {
    id                   = yandex_lockbox_secret.vk_secrets.id
    version_id           = data.yandex_lockbox_secret.vk_secrets.current_version[0].id
    key                  = "vk_secret"
    environment_variable = "VK_SECRET"
  }

  secrets {
    id                   = yandex_lockbox_secret.vk_secrets.id
    version_id           = data.yandex_lockbox_secret.vk_secrets.current_version[0].id
    key                  = "vk_confirmation_code"
    environment_variable = "VK_CONFIRMATION_CODE"
  }

  secrets {
    id                   = yandex_lockbox_secret.vk_secrets.id
    version_id           = data.yandex_lockbox_secret.vk_secrets.current_version[0].id
    key                  = "vk_group_token"
    environment_variable = "VK_GROUP_TOKEN"
  }

  depends_on = [
    yandex_resourcemanager_folder_iam_member.webhook_lockbox,
    yandex_resourcemanager_folder_iam_member.webhook_cr_puller,
    yandex_message_queue.jobs_queue
  ]
}

# Make Webhook Container publicly reachable by VK Callback API
resource "yandex_serverless_container_iam_binding" "webhook_public" {
  container_id = yandex_serverless_container.webhook.id
  role         = "serverless.containers.invoker"
  members      = ["system:allUsers"]
}

# 7. Worker Service (Private Worker Container invoked by Trigger)
resource "yandex_serverless_container" "worker" {
  name               = "readable-web-worker"
  folder_id          = var.folder_id
  memory             = 2048
  cores              = 2
  core_fraction      = 100
  execution_timeout  = "120s"
  service_account_id = yandex_iam_service_account.worker_sa.id

  metadata_options {
    gce_http_endpoint = 1
  }

  image {
    url = "cr.yandex/${yandex_container_registry.registry.id}/worker:${var.worker_image_tag}"
    environment = {
      NODE_ENV                 = "production"
      APP_VERSION              = "12"
      WORKER_PORT              = "8080"
      YDB_ENDPOINT             = yandex_ydb_database_serverless.db.ydb_api_endpoint
      YDB_DATABASE             = yandex_ydb_database_serverless.db.database_path
      YDB_METADATA_CREDENTIALS = "1"
    }
  }

  secrets {
    id                   = yandex_lockbox_secret.vk_secrets.id
    version_id           = data.yandex_lockbox_secret.vk_secrets.current_version[0].id
    key                  = "vk_group_token"
    environment_variable = "VK_GROUP_TOKEN"
  }

  depends_on = [
    yandex_resourcemanager_folder_iam_member.worker_lockbox,
    yandex_resourcemanager_folder_iam_member.worker_cr_puller
  ]
}

# 8. YMQ Trigger invoking Worker Container
resource "yandex_function_trigger" "ymq_trigger" {
  name        = "readable-web-ymq-trigger"
  folder_id   = var.folder_id
  description = "Dispatches jobs from YMQ to Worker Container with batch size 1"

  message_queue {
    queue_id           = yandex_message_queue.jobs_queue.arn
    service_account_id = yandex_iam_service_account.trigger_sa.id
    batch_size         = "1"
    batch_cutoff       = "1"
  }

  container {
    id                 = yandex_serverless_container.worker.id
    service_account_id = yandex_iam_service_account.trigger_sa.id
  }
}

output "webhook_url" {
  value       = yandex_serverless_container.webhook.url
  description = "Public URL for VK Callback API configuration"
}

output "registry_id" {
  value       = yandex_container_registry.registry.id
  description = "Container Registry ID for docker push"
}
