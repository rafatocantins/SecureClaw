#!/usr/bin/env bash
# REQUIRES: bash (not sh-compatible). Windows users: run via Git Bash or WSL2.
# build-tools.sh — Build all Tessera built-in tool Docker images.
#
# Usage:
#   ./scripts/build-tools.sh                     # build all, tag :latest
#   ./scripts/build-tools.sh --push              # build + push to registry
#   TAG=v1.2.3 ./scripts/build-tools.sh          # custom tag
#   TAG=v1.2.3 ./scripts/build-tools.sh --push   # custom tag + push
#
# Requires Docker BuildKit (Docker 24+ or DOCKER_BUILDKIT=1).
set -euo pipefail

REPO="${REPO:-tessera}"
TAG="${TAG:-latest}"
PUSH="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TOOLS=(
  "shell-exec"
  "http-request"
  "file-read"
  "file-write"
)

echo "==> Building Tessera tool images (tag: ${TAG})"
echo "    context: ${ROOT}"
echo

for tool in "${TOOLS[@]}"; do
  image="${REPO}/${tool}:${TAG}"
  dockerfile="docker/tool-${tool}.Dockerfile"

  echo "--> Building ${image} from ${dockerfile}"
  docker build \
    --file "${ROOT}/${dockerfile}" \
    --tag "${image}" \
    --progress=plain \
    "${ROOT}"

  if [ "${PUSH}" = "--push" ]; then
    echo "--> Pushing ${image}"
    docker push "${image}"
  fi

  echo
done

echo "==> All tool images built successfully."
echo
echo "    Images:"
for tool in "${TOOLS[@]}"; do
  echo "      ${REPO}/${tool}:${TAG}"
done

if [ "${PUSH}" != "--push" ]; then
  echo
  echo "    To push: TAG=${TAG} ${0} --push"
fi
