#!/usr/bin/env bash
# Manual deploy (tech spec §CI/CD): invoked by the workflow_dispatch job over SSH,
# after it has `git pull`ed the new code. App images are built HERE from that
# checkout — compose's app services are `build:`-only, so a `pull` alone would
# leave the old images running. Then forward-only migrations, then app start.
set -euo pipefail

cd "$(dirname "$0")"

# Compose now REQUIRES POSTGRES_PASSWORD (no default), so load the repo-root
# .env — the same file with-env.sh reads — when this runs outside a shell that
# already has it (the deploy SSH session, cron).
if [ -f ../.env ]; then set -a; . ../.env; set +a; fi

echo "==> Pulling base images"
docker compose pull postgres

echo "==> Building app images from this checkout"
docker compose build

echo "==> Running forward-only migrations (before app start)"
docker compose up --exit-code-from migrate migrate

echo "==> Starting/refreshing app containers"
docker compose up -d

echo "==> Deploy complete"
docker compose ps
