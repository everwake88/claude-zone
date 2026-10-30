#!/usr/bin/env bash
# Dresses a checkout of the desk (2b-desk/) for filming: Everwake colours and
# mark, a made-up store ("Volta") in the demo data, and one more human agent
# (youssef.kamal) that the demo leaves alone, to receive a transfer.
#   ./prepare.sh /path/to/2b-desk
set -euo pipefail
D="${1:?path to 2b-desk}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
sed -i "s/employee_id: '2B-/employee_id: 'VL-/g; s/\`2B-\${/\`VL-\${/; s/من 2B،/من Volta،/; s/مساعد 2B الذكي/مساعد Volta الذكي/" "$D/server/src/demo.js"
sed -i "s#humans = Object.values(HUMANS).map((h) => h.username),#humans = [...Object.values(HUMANS).map((h) => h.username), 'youssef.kamal'],#" "$D/server/src/demo.js"
mkdir -p "$D/web/assets/fonts"
cp "$HERE"/../fonts/ibm-plex-sans-arabic-arabic-{400,500,600,700}-normal.woff2 "$D/web/assets/fonts/"
cp "$ROOT/brand/logo/everwake-mark.svg" "$D/web/assets/img/mark.svg"
for f in topbar.js login.js; do sed -i 's#<span class="brand__mark">2B</span>#<span class="brand__mark"><img src="assets/img/mark.svg" alt="" /></span>#g' "$D/web/assets/js/ui/$f"; done
sed -i 's#<div class="boot__logo">2B</div>#<div class="boot__logo"></div>#' "$D/web/assets/js/main.js" "$D/web/index.html"
sed -i 's#Open 2B Desk to reply.#Open the desk to reply.#' "$D/web/assets/js/state.js"
sed -i 's#"2B Desk"#"Everwake Desk"#; s#<title>2B Desk</title>#<title>Everwake Desk</title>#' "$D/web/config.js" "$D/web/index.html"
sed -i "s#(CFG.brandName || '2B Desk').replace(/^2B\\\\s\*/, '') || 'Desk'#CFG.brandName || 'Desk'#" "$D/web/assets/js/ui/topbar.js"
grep -q "Everwake skin" "$D/web/assets/css/app.css" || cat "$HERE/everwake-skin.css" >> "$D/web/assets/css/app.css"
echo "dressed $D"
