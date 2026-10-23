#!/usr/bin/env bash
# Everwake · put a backup of n8n's database back.
#   ./scripts/restore.sh backups/n8n-2026-10-23_0330.sql.gz
# Needs the SAME N8N_ENCRYPTION_KEY in .env as when the backup was made.
set -euo pipefail
cd "$(dirname "$0")/.."
file=${1:?usage: restore.sh backups/n8n-….sql.gz}
[ -f "$file" ] || { echo "No such file: $file"; exit 1; }
read -r -p "This replaces n8n's current workflows and credentials with $file. Type yes: " ok
[ "$ok" = "yes" ] || { echo "Nothing changed."; exit 1; }

# WHY stop n8n first: nothing may write to the database while it is being replaced
docker compose stop n8n
docker compose --profile queue stop n8n-worker 2>/dev/null || true
gzip -dc "$file" | docker compose exec -T n8n-db psql -q -v ON_ERROR_STOP=1 -U n8n -d n8n
docker compose up -d n8n
echo "Restored. Open n8n and check the workflows are active."
