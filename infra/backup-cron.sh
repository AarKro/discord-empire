#!/usr/bin/env bash
# Nightly pg_dump backup (tech spec §CI/CD: "rollback = restore from the nightly
# pg_dump"). Install on the VPS via crontab, e.g.:
#   0 3 * * * /opt/discord-empire/infra/backup-cron.sh >> /var/log/empire-backup.log 2>&1
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/empire}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
docker compose -f "$(dirname "$0")/docker-compose.yml" exec -T postgres \
  pg_dump -U empire -d empire | gzip > "$BACKUP_DIR/empire_$STAMP.sql.gz"

# Prune old dumps.
find "$BACKUP_DIR" -name 'empire_*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
echo "backup written: $BACKUP_DIR/empire_$STAMP.sql.gz"
