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

DEPLOY_START_TIME=$(date +%s)

format_duration() {
  local total_seconds=$1
  local minutes=$(( total_seconds / 60 ))
  local seconds=$(( total_seconds % 60 ))
  if [ "$minutes" -gt 0 ]; then
    echo "${minutes}m ${seconds}s"
  else
    echo "${seconds}s"
  fi
}

BUILD_WEBHOOK_DURATION=0
PUSH_WEBHOOK_DURATION=0
BUILD_WORKER_DURATION=0
PUSH_WORKER_DURATION=0
TF_APPLY_DURATION=0

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

# 5. Generate unique image tag and resolve application version
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "app")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TAG="${TAG:-${GIT_SHA}-${TIMESTAMP}}"
echo "🏷️ Image Tag: $TAG"

PKG_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")
APP_VERSION="${APP_VERSION:-v${PKG_VERSION} (${GIT_SHA})}"
echo "📦 App Version: $APP_VERSION"

TF_VARS=("-var=app_version=$APP_VERSION")

# 6. Build and Push Webhook if selected
if [[ "$TARGET" == "webhook" || "$TARGET" == "all" ]]; then
  echo ""
  echo "🔨 [1/2] Building Webhook Container (linux/amd64)..."
  BUILD_WH_START=$(date +%s)
  docker build --platform linux/amd64 \
    -t "cr.yandex/$REGISTRY_ID/webhook:$TAG" \
    -t "cr.yandex/$REGISTRY_ID/webhook:latest" \
    -f infra/containers/Dockerfile.webhook .
  BUILD_WEBHOOK_DURATION=$(( $(date +%s) - BUILD_WH_START ))
  echo "⏱️  Built Webhook Container in $(format_duration "$BUILD_WEBHOOK_DURATION")"

  echo ""
  echo "🚀 [1/2] Pushing Webhook Container..."
  PUSH_WH_START=$(date +%s)
  docker push "cr.yandex/$REGISTRY_ID/webhook:$TAG"
  docker push "cr.yandex/$REGISTRY_ID/webhook:latest"
  PUSH_WEBHOOK_DURATION=$(( $(date +%s) - PUSH_WH_START ))
  echo "⏱️  Pushed Webhook Container in $(format_duration "$PUSH_WEBHOOK_DURATION")"

  TF_VARS+=("-var=webhook_image_tag=$TAG")
fi

# 7. Build and Push Worker if selected
if [[ "$TARGET" == "worker" || "$TARGET" == "all" ]]; then
  echo ""
  echo "🔨 [2/2] Building Worker Container (linux/amd64)..."
  BUILD_WRK_START=$(date +%s)
  docker build --platform linux/amd64 \
    -t "cr.yandex/$REGISTRY_ID/worker:$TAG" \
    -t "cr.yandex/$REGISTRY_ID/worker:latest" \
    -f infra/containers/Dockerfile.worker .
  BUILD_WORKER_DURATION=$(( $(date +%s) - BUILD_WRK_START ))
  echo "⏱️  Built Worker Container in $(format_duration "$BUILD_WORKER_DURATION")"

  echo ""
  echo "🚀 [2/2] Pushing Worker Container..."
  PUSH_WRK_START=$(date +%s)
  docker push "cr.yandex/$REGISTRY_ID/worker:$TAG"
  docker push "cr.yandex/$REGISTRY_ID/worker:latest"
  PUSH_WORKER_DURATION=$(( $(date +%s) - PUSH_WRK_START ))
  echo "⏱️  Pushed Worker Container in $(format_duration "$PUSH_WORKER_DURATION")"

  TF_VARS+=("-var=worker_image_tag=$TAG")
fi

# 8. Deploy new revision(s) via Terraform
echo ""
echo "⚡ Applying Terraform to deploy new Serverless Container revision(s)..."
TF_START=$(date +%s)
terraform -chdir=infra/yandex apply "${TF_VARS[@]}" -auto-approve
TF_APPLY_DURATION=$(( $(date +%s) - TF_START ))
echo "⏱️  Terraform apply completed in $(format_duration "$TF_APPLY_DURATION")"

TOTAL_DURATION=$(( $(date +%s) - DEPLOY_START_TIME ))
TOTAL_BUILD_DURATION=$(( BUILD_WEBHOOK_DURATION + BUILD_WORKER_DURATION ))
TOTAL_PUSH_DURATION=$(( PUSH_WEBHOOK_DURATION + PUSH_WORKER_DURATION ))

echo ""
echo "=================================================="
echo "✅ Deployment finished successfully!"
echo "📦 Deployed version [$APP_VERSION]"
WEBHOOK_URL=$(terraform -chdir=infra/yandex output -raw webhook_url 2>/dev/null || true)
if [ -n "$WEBHOOK_URL" ]; then
  echo "🌐 Webhook URL: $WEBHOOK_URL"
fi
echo ""
echo "⏱️  Timing Summary:"
if [[ "$TARGET" == "all" ]]; then
  echo "  • Building images:  $(format_duration "$TOTAL_BUILD_DURATION") (webhook: $(format_duration "$BUILD_WEBHOOK_DURATION"), worker: $(format_duration "$BUILD_WORKER_DURATION"))"
  echo "  • Pushing images:   $(format_duration "$TOTAL_PUSH_DURATION") (webhook: $(format_duration "$PUSH_WEBHOOK_DURATION"), worker: $(format_duration "$PUSH_WORKER_DURATION"))"
else
  echo "  • Building images:  $(format_duration "$TOTAL_BUILD_DURATION")"
  echo "  • Pushing images:   $(format_duration "$TOTAL_PUSH_DURATION")"
fi
echo "  • Terraform apply:  $(format_duration "$TF_APPLY_DURATION")"
echo "  --------------------------------------------------"
echo "  • Overall duration: $(format_duration "$TOTAL_DURATION")"
echo "=================================================="
