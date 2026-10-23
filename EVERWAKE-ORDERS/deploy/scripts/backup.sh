#!/usr/bin/env bash
# Everwake · back up n8n's database (its workflows, credentials and settings).
# Nightly from cron (see the guide). The restaurants' data is in Supabase and
# backed up there; this is everything else that would be lost with the server.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
KEEP=${BACKUP_KEEP_DAYS:-14}
mkdir -p backups && chmod 700 backups

file="backups/n8n-$(date +%F_%H%M).sql.gz"
# WHY pg_dump: a consistent copy while n8n keeps running — no downtime
docker compose exec -T n8n-db pg_dump -U n8n -d n8n --no-owner --clean --if-exists | gzip > "$file.part"
# WHY the size check: an empty or broken dump must not replace good ones silently
if [ "$(gzip -dc "$file.part" | head -c 100000 | grep -c 'CREATE TABLE' || true)" -lt 5 ]; then
  echo "$(date -Is) BACKUP FAILED: the dump looks empty" | tee -a backups/backup.log; rm -f "$file.part"; exit 1
fi
mv "$file.part" "$file"
chmod 600 "$file"

# WHY delete old ones: a full disk is one of the classic ways servers crash
find backups -name 'n8n-*.sql.gz' -mtime +"$KEEP" -delete

# WHY off the server: a backup on the same disk does not survive losing the server
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$file" "$BACKUP_REMOTE" && echo "$(date -Is) copied to $BACKUP_REMOTE" >> backups/backup.log
fi
echo "$(date -Is) ok $file $(du -h "$file" | cut -f1)" >> backups/backup.log
echo "ok $file"
