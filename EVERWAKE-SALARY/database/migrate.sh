#!/usr/bin/env bash
# Everwake Salary · build or update the database on your own Postgres server.
# Every migration is safe to run again (create … if not exists / create or replace).
#
#   DATABASE_URL=postgres://user:pass@host:5432/dbname ./database/migrate.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?set DATABASE_URL to your Postgres connection string}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
for f in migrations/0*.sql; do
  echo "→ $f"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "Database is up to date."
