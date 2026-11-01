#!/bin/sh
# AMO live opt-in check (P4-T04) — explicitly-marked opt-in, NEVER in CI.
# Verifies every equivalent/alternative gallery slug still resolves to a
# public listing on addons.mozilla.org. Requires network + curl.
# Usage: crates/astra-extensions/tests/amo_live_optin.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GALLERY="$ROOT/gallery.json"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
python3 - "$GALLERY" > "$LIST" <<'EOF'
import json, sys
doc = json.load(open(sys.argv[1]))
for e in doc["entries"]:
    f = e["firefox"]
    if f["status"] in ("equivalent", "alternative"):
        print(e["name"] + "\t" + f["slug"] + "\t" + f["amo_url"])
EOF
FAIL=0
COUNT=0
while IFS="$(printf '\t')" read -r name slug url; do
  COUNT=$((COUNT + 1))
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)"
  # AMO serves the listing HTML at 200 for public add-ons.
  if [ "$code" != "200" ]; then
    echo "NOT PUBLIC ($code): $name $url" >&2
    FAIL=1
  else
    echo "OK: $name ($slug)"
  fi
done < "$LIST"
echo "checked $COUNT gallery URLs"
exit $FAIL
