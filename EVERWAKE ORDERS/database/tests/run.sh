#!/usr/bin/env bash
# Everwake Orders · database tests
# Builds a fresh database from the migrations, loads the demo restaurant,
# and runs every tests/*.sql file. Any failed assert stops the run.
#
#   PGHOST=localhost PGUSER=tester PGPASSWORD=tester ./run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${TEST_DB:-everwake_test}"
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-tester}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "$DB")

psql -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
for f in migrations/0*.sql; do
  [[ "$(basename "$f")" == 090_* ]] && continue      # Supabase-only
  "${PSQL[@]}" -f "$f"
done
"${PSQL[@]}" -f seed/demo_restaurant.sql

pass=0
for t in tests/[0-9]*.sql; do
  printf '%-40s ' "$(basename "$t")"
  if out=$("${PSQL[@]}" -f "$t" 2>&1); then
    echo "ok"; pass=$((pass + 1))
  else
    echo "FAILED"; echo "$out" | sed 's/^/    /'; exit 1
  fi
done
echo "all $pass test files passed"
