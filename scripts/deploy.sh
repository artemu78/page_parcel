#!/usr/bin/env bash
set -euo pipefail

# Ensure script runs from the repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-all}"
if [[ "$TARGET" != "webhook" && "$TARGET" != "worker" && "$TARGET" != "all" ]]; then
  echo "❌ Invalid target: '$TARGET'"
  echo "Usage: $0 [webhook|worker|all]"
  exit 1
fi

echo "=================================================="
echo "🚀 Readable Web Deployment: Target = $TARGET"
echo "=================================================="

# 1. Check Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "❌ Error: Docker daemon is not running. Please start Docker."
  exit 1
fi

# 2. Check Terraform
if ! command -v terraform >/dev/null 2>&1; then
  echo "❌ Error: Terraform CLI is not installed or not in PATH."
  exit 1
fi

# 3. Authenticate with Yandex Container Registry
if [ -f "infra/yandex/authorized_key.json" ]; then
  echo "🔑 Authenticating Docker with cr.yandex..."
  cat infra/yandex/authorized_key.json | docker login --username json_key --password-stdin cr.yandex >/dev/null 2>&1 || {
    echo "⚠️ Warning: Login with authorized_key.json failed. Attempting with existing Docker credentials..."
  }
fi

# 4. Resolve Registry ID from Terraform
echo "🔍 Fetching Registry ID from Terraform output..."
REGISTRY_ID=$(terraform -chdir=infra/yandex output -raw registry_id 2>/dev/null || true)
if [ -z "$REGISTRY_ID" ]; then
  echo "❌ Error: Could not determine registry_id. Run terraform in infra/yandex first."
  exit 1
fi
echo "📦 Registry ID: $REGISTRY_ID"

# 5. Generate unique image tag
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "app")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TAG="${TAG:-${GIT_SHA}-${TIMESTAMP}}"
echo "🏷️ Image Tag: $TAG"

TF_VARS=()

# 6. Build and Push Webhook if selected
if [[ "$TARGET" == "webhook" || "$TARGET" == "all" ]]; then
  echo ""
  echo "🔨 [1/2] Building Webhook Container (linux/amd64)..."
  docker build --platform linux/amd64 \
    -t "cr.yandex/$REGISTRY_ID/webhook:$TAG" \
    -t "cr.yandex/$REGISTRY_ID/webhook:latest" \
    -f infra/containers/Dockerfile.webhook .

  echo "🚀 [1/2] Pushing Webhook Container..."
  docker push "cr.yandex/$REGISTRY_ID/webhook:$TAG"
  docker push "cr.yandex/$REGISTRY_ID/webhook:latest"

  TF_VARS+=("-var=webhook_image_tag=$TAG")
fi

# 7. Build and Push Worker if selected
if [[ "$TARGET" == "worker" || "$TARGET" == "all" ]]; then
  echo ""
  echo "🔨 [2/2] Building Worker Container (linux/amd64)..."
  docker build --platform linux/amd64 \
    -t "cr.yandex/$REGISTRY_ID/worker:$TAG" \
    -t "cr.yandex/$REGISTRY_ID/worker:latest" \
    -f infra/containers/Dockerfile.worker .

  echo "🚀 [2/2] Pushing Worker Container..."
  docker push "cr.yandex/$REGISTRY_ID/worker:$TAG"
  docker push "cr.yandex/$REGISTRY_ID/worker:latest"

  TF_VARS+=("-var=worker_image_tag=$TAG")
fi

# 8. Deploy new revision(s) via Terraform
echo ""
echo "⚡ Applying Terraform to deploy new Serverless Container revision(s)..."
terraform -chdir=infra/yandex apply "${TF_VARS[@]}" -auto-approve

echo ""
echo "=================================================="
echo "✅ Deployment finished successfully!"
WEBHOOK_URL=$(terraform -chdir=infra/yandex output -raw webhook_url 2>/dev/null || true)
if [ -n "$WEBHOOK_URL" ]; then
  echo "🌐 Webhook URL: $WEBHOOK_URL"
fi
echo "=================================================="
