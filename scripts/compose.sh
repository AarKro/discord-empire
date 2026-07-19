#!/bin/sh
# Run docker compose against infra/docker-compose.yml, falling back to the
# legacy docker-compose binary. Shared by `pnpm start`/`stop`.
set -e
if docker compose version >/dev/null 2>&1; then
  exec docker compose -f infra/docker-compose.yml "$@"
fi
exec docker-compose -f infra/docker-compose.yml "$@"
