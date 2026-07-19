#!/bin/sh
# Load .env into the environment (with CONTENT_DIR defaulted to the repo's
# content/), then exec the given command. Shared by `pnpm start`/`world:init`.
set -e
[ -f .env ] || { echo 'No .env found — run: cp .env.example .env' >&2; exit 1; }
set -a
. ./.env
set +a
export CONTENT_DIR="${CONTENT_DIR:-$PWD/content}"
exec "$@"
