#!/usr/bin/env bash
# Manual deploy (tech spec §CI/CD): invoked by the workflow_dispatch job over SSH.
# Pulls new images, runs forward-only migrations, then starts app containers.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling images"
docker compose pull

echo "==> Running forward-only migrations (before app start)"
docker compose up --exit-code-from migrate migrate

echo "==> Starting/refreshing app containers"
docker compose up -d

echo "==> Deploy complete"
docker compose ps
