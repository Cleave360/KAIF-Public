#!/usr/bin/env bash
set -euo pipefail

ACR_NAME="${ACR_NAME:-kaifacra4c02bd7}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-kaif/server}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
SOURCE_IMAGE="${SOURCE_IMAGE:-kaif-kaif-server:latest}"

if ! command -v az >/dev/null 2>&1; then
  echo "MISSING_DEPENDENCY=az"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "MISSING_DEPENDENCY=docker"
  exit 1
fi

login_server="$(az acr show --name "${ACR_NAME}" --query loginServer -o tsv)"
target_image="${login_server}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"

echo "Publishing KAIF server image"
echo "SOURCE_IMAGE=${SOURCE_IMAGE}"
echo "TARGET_IMAGE=${target_image}"

az acr login --name "${ACR_NAME}" >/dev/null
docker tag "${SOURCE_IMAGE}" "${target_image}"
docker push "${target_image}"

echo "PUBLISHED_IMAGE=${target_image}"
