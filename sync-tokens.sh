#!/usr/bin/env sh
# Everwake — propagate the canonical design tokens to every deliverable.
# brand/tokens/everwake.css is the single source of truth. Run this after
# changing it so the website, deck and templates stay in step.
set -eu
cd "$(dirname "$0")"
SRC="brand/tokens/everwake.css"

for dest in \
  "web/assets/css/tokens.css" \
  "deck/assets/tokens.css" \
  "templates/proposal/assets/tokens.css"
do
  mkdir -p "$(dirname "$dest")"
  cp "$SRC" "$dest"
  echo "  → $dest"
done
echo "Tokens synced from $SRC"
