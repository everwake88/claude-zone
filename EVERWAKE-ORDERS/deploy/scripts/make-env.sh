#!/usr/bin/env bash
# Everwake · create .env from .env.example and fill in the secrets.
# Never overwrites a secret that is already set, so it is safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
chmod 600 .env       # WHY: only you can read the file that holds the keys

fill() {   # fill <NAME> <bytes>: a random hex secret, only if empty
  local name=$1 bytes=$2 value
  if grep -qE "^${name}=$" .env; then
    value=$(openssl rand -hex "$bytes")
    sed -i "s|^${name}=$|${name}=${value}|" .env
    echo "generated ${name}"
  fi
}
fill N8N_ENCRYPTION_KEY 32
fill N8N_DB_PASSWORD 24
fill REDIS_PASSWORD 24

missing=$(grep -E '^(N8N_HOST|ACME_EMAIL|N8N_VERSION)=$' .env | cut -d= -f1 || true)
grep -qE '^ACME_EMAIL=you@example.com$' .env && missing="$missing ACME_EMAIL"
if [ -n "${missing// /}" ]; then
  echo "Now open .env and set: $missing"
  echo "  N8N_VERSION = the version your current n8n runs (Help → About n8n)"
fi
echo
echo "IMPORTANT: copy the finished .env into your password manager."
echo "Without N8N_ENCRYPTION_KEY the credentials saved in n8n cannot be read after a rebuild."
