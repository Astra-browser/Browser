#!/bin/sh
# brand-lint (P0-T05, §3.4): fail if the previous product name appears in the
# repo or built artifacts outside the allow-list.
# Usage: tools/brand-lint.sh [path...]   (default: repo root)
# Excludes: .git, folder_context (reference snapshot), LICENSE, NOTICE,
# docs/astra/PROVENANCE.md, target/, node_modules/, engine/ (upstream),
# build outputs (dist/, reports/ — scanned post-build by the packaging gate
# instead), the staged chrome app bundle (overlay/astra/chrome/app/: generated
# by `bun run --filter @astra/frame build:chrome`, audited in
# docs/astra/SHELL_APP.md §5 — same rationale as dist/), and the generated IPC
# bindings (Tauri Specta output, regenerated
# from astra-proto in P2-T02 which mints the new channel names; tracked in
# docs/astra/REBRAND-ui.md).
# Generated-file exception: ui/app/src/shared/ipc/bindings.ts (expires P2-T02).
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
  --exclude-dir=dist --exclude-dir=reports \
  --exclude='*.png' --exclude='*.webp' --exclude='*.ico' --exclude='*.icns' \
  -i "$PATTERN" $TARGETS 2>/dev/null || true)"
for f in $FOUND; do
  case "$f" in
    ./LICENSE|./NOTICE|./docs/astra/PROVENANCE.md|LICENSE|NOTICE|docs/astra/PROVENANCE.md|./ui/app/src/shared/ipc/bindings.ts|ui/app/src/shared/ipc/bindings.ts)
      continue ;;
    ./overlay/astra/chrome/app/*|overlay/astra/chrome/app/*)
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
