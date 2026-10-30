#!/usr/bin/env bash
# A clean take: two fresh simulated days, Youssef added, the desk restarted in
# demo mode on port 8090 (log in /var/tmp/ewdemo/desk.log).
#   DESK=/path/to/2b-desk ./reset.sh
set -euo pipefail
cd "${DESK:?path to 2b-desk}/server"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres@%2Ftmp:5433/desk_demo}"
kill $(pgrep -f '^node src/index.js') 2>/dev/null || true
npm run --silent demo:seed -- --yes-wipe | tail -1
npm run --silent users:create -- --name "Youssef Kamal" --username youssef.kamal --employee VL-026 --password demo1234 | tail -1
mkdir -p /var/tmp/ewdemo
DESK_INGEST_SECRET=film-secret DEMO_MODE=true PORT=8090 nohup node src/index.js > /var/tmp/ewdemo/desk.log 2>&1 &
until curl -s -o /dev/null localhost:8090/api/health; do sleep 0.5; done
echo "desk ready on :8090"
