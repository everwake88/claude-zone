#!/usr/bin/env bash
# Starts everything filming needs, on this machine: Postgres (port 5433),
# the Supabase stand-in (54321) and the production dashboard (port 80,
# opened by the camera as orders.everwake.tech). Run setup.sh first, once.
#
#   PGDATA=/var/tmp/ewpg/data ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
PGDATA="${PGDATA:-/var/tmp/ewpg/data}"
RUN="${RUN_DIR:-/var/tmp/ewdemo}"
mkdir -p "$RUN"

if ! pg_isready -q -h /tmp -p 5433; then
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 5433 -k /tmp' -l $PGDATA/../log.txt start" > /dev/null
  until pg_isready -q -h /tmp -p 5433; do sleep 0.5; done
fi
echo "postgres ready"

if ! curl -s -o /dev/null localhost:54321/auth/v1/settings; then
  STORAGE_DIR="${STORAGE_DIR:-$RUN/storage}" PRINT_KEYS=1 nohup node local-supabase.mjs > "$RUN/gw.log" 2>&1 &
  until curl -s -o /dev/null localhost:54321/auth/v1/settings; do sleep 0.5; done
fi
KEYS=$(grep -m1 '^{"anon"' "$RUN/gw.log")
echo "supabase stand-in ready"

if ! curl -s -o /dev/null localhost:80/login; then
  cd ../../dashboard
  export NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_TELEMETRY_DISABLED=1
  export NEXT_PUBLIC_SUPABASE_ANON_KEY=$(node -pe "JSON.parse(process.argv[1]).anon" "$KEYS")
  export SUPABASE_SERVICE_ROLE_KEY=$(node -pe "JSON.parse(process.argv[1]).service" "$KEYS")
  [ -d .next ] || npx next build > "$RUN/next-build.log" 2>&1
  nohup npx next start -p 80 > "$RUN/next.log" 2>&1 &
  until curl -s -o /dev/null localhost:80/login; do sleep 0.5; done
fi
echo "dashboard ready on port 80"
