#!/usr/bin/env bash
# Builds the filming database from scratch: every migration, the showcase
# restaurant (its 30 days of history end "now"), Supabase's stand-ins, and
# the realtime triggers. Run before each full capture so every take starts
# from the same place.
#
#   PGHOST=/tmp PGPORT=5433 ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
DB="${FILM_DB:-everwake}"
EMAIL="${FILM_EMAIL:-demo@everwake.tech}"
ROOT=../../database
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -U "${PGUSER:-postgres}")

"${PSQL[@]}" -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB' and pid <> pg_backend_pid()" > /dev/null
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
"${PSQL[@]}" -d "$DB" -f supabase-stub.sql -v email="$EMAIL" 2>&1 | grep -v "wal_level\|HINT" || true
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/fixtures/vault_stub.sql"
for f in "$ROOT"/migrations/0*.sql; do "${PSQL[@]}" -d "$DB" -f "$f" > /dev/null 2>&1 || { echo "failed: $f"; exit 1; }; done
sed "s/v_owner_email text := '';/v_owner_email text := '$EMAIL';/" "$ROOT/tools/showcase_restaurant.sql" | "${PSQL[@]}" -d "$DB" > /dev/null
"${PSQL[@]}" -d "$DB" -f realtime.sql > /dev/null 2>&1
rm -rf "${STORAGE_DIR:-/var/tmp/ewdemo/storage}" && mkdir -p "${STORAGE_DIR:-/var/tmp/ewdemo/storage}"
echo "filming database ready: $("${PSQL[@]}" -d "$DB" -Atc "select count(*) || ' orders' from everwake.orders")"
