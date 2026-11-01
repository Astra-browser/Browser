#!/bin/sh
# brand-lint (P0-T05, §3.4): fail if the previous product name appears in the
# repo or built artifacts outside the allow-list.
# Usage: tools/brand-lint.sh [path...]   (default: repo root)
# Excludes: .git, folder_context (reference snapshot), LICENSE, NOTICE,
# docs/astra/PROVENANCE.md, target/, node_modules/, engine/ (upstream).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TARGETS="${*:-.}"
# Case-insensitive match on the previous product name, all variants.
# NOTE: the pattern is assembled from parts so this script does not match
# itself during its own scan. Runtime value is identical to the plain literal.
PATTERN='zeph''ium'
ALLOW='^(./)?(LICENSE|NOTICE|docs/astra/PROVENANCE\.md)$'
FAIL=0
FOUND="$(grep -rIl --exclude-dir=.git --exclude-dir=folder_context \
  --exclude-dir=target --exclude-dir=node_modules --exclude-dir=engine \
  --exclude='*.png' --exclude='*.webp' --exclude='*.ico' --exclude='*.icns' \
  -i "$PATTERN" $TARGETS 2>/dev/null || true)"
for f in $FOUND; do
  case "$f" in
    ./LICENSE|./NOTICE|./docs/astra/PROVENANCE.md|LICENSE|NOTICE|docs/astra/PROVENANCE.md)
      continue ;;
    *)
      echo "brand-lint: forbidden match in $f" >&2
      FAIL=1 ;;
  esac
done
if [ "$FAIL" -ne 0 ]; then
  echo "brand-lint: FAILED" >&2
  exit 1
fi
echo "brand-lint: clean"
