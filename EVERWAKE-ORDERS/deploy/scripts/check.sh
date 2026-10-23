#!/usr/bin/env bash
# Everwake · how is the server doing? Run any time:  ./scripts/check.sh
# It also says when it is time to upgrade (Phase 2).
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
warn=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; warn=1; }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; warn=1; }

echo "Containers"
docker compose ps --format '  {{.Service}}: {{.State}} {{.Health}}' 2>/dev/null
for s in caddy n8n n8n-db; do
  st=$(docker compose ps --format '{{.State}}' "$s" 2>/dev/null)
  [ "$st" = "running" ] || bad "$s is not running ($st) — docker compose up -d $s; docker compose logs --tail 50 $s"
done

echo "n8n from the internet"
ready=0
for i in 1 2 3; do   # n8n needs up to a minute after a restart
  curl -fsS -m 10 "https://${N8N_HOST}/healthz/readiness" >/dev/null 2>&1 && { ready=1; break; }; sleep 10
done
if [ "$ready" -eq 1 ]; then ok "https://${N8N_HOST} answers (and reaches its database)"
else bad "https://${N8N_HOST}/healthz/readiness does not answer — check DNS, Caddy (docker compose logs caddy) and n8n"; fi

echo "Memory"
read -r total used <<<"$(free -m | awk '/^Mem:/ {print $2, $3}')"
swap=$(free -m | awk '/^Swap:/ {print $3}')
pct=$(( used * 100 / total ))
[ "$pct" -lt 80 ] && ok "RAM ${used}/${total} MB (${pct}%)" || note "RAM ${used}/${total} MB (${pct}%) — high; see 'When to upgrade'"
[ "${swap:-0}" -lt 512 ] && ok "swap in use: ${swap} MB" || note "swap in use: ${swap} MB — the server is short of memory at times"
docker stats --no-stream --format '  {{.Name}}: {{.MemUsage}} · CPU {{.CPUPerc}}' 2>/dev/null | grep everwake

echo "Disk"
dpct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$dpct" -lt 80 ] && ok "disk ${dpct}% used" || note "disk ${dpct}% used — docker system prune -f, and check backups/"

echo "Backups"
last=$(ls -1t backups/n8n-*.sql.gz 2>/dev/null | head -1)
if [ -z "$last" ]; then bad "no backup yet — ./scripts/backup.sh, and add the nightly cron line"
else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
  [ "$age_h" -le 30 ] && ok "latest: $last (${age_h} h ago)" || bad "latest backup is ${age_h} h old: $last — is the cron line installed?"
fi

echo "n8n errors in the last 24 h"
errs=$(docker compose logs --no-log-prefix --since 24h n8n 2>/dev/null | grep -iE 'error|exception' | grep -cvE '^[[:space:]]+at ' || true)
[ "${errs:-0}" -lt 20 ] && ok "${errs} error lines" || note "${errs} error lines — docker compose logs --since 24h n8n | grep -i error | tail"

echo
[ "$warn" -eq 0 ] && echo "All good." || echo "Something needs a look (above)."
