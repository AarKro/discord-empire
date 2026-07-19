#!/bin/sh
# Full dev stack: Postgres up → migrate → build → all apps in parallel.
# Run through with-env.sh so .env/CONTENT_DIR are loaded for every step.
set -e
"$(dirname "$0")/compose.sh" up -d --wait postgres
pnpm db:migrate
pnpm build
exec pnpm --parallel --filter './apps/*' start
