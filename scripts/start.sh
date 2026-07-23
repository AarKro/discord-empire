#!/bin/sh
# Full dev stack, one command: Postgres up → migrate → build → seed world → all
# apps in parallel. Each step is conditional/idempotent, so reruns skip work:
#   - db:migrate applies only pending migrations (no-op when none)
#   - build (tsc -b) is incremental
#   - world-init self-skips when the world is already seeded (see world-init.ts)
# Run through with-env.sh so .env/CONTENT_DIR are loaded for every step.
set -e
"$(dirname "$0")/compose.sh" up -d --wait postgres
pnpm db:migrate
pnpm build
pnpm exec tsx scripts/world-init.ts   # first run seeds the world; later runs skip
exec pnpm --parallel --filter './apps/*' start
