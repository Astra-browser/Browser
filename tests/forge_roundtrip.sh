#!/bin/bash
# tests/forge_roundtrip.sh (P1-T12): forge export -> reset -> import round-trip.
# Asserts the engine/ tree (tracked upstream files) is byte-identical after
# the cycle. Untracked overlay output (engine/astra/) is recreated by
# `forge overlay`, not by patches, so it is snapshotted but expected to be
# untouched throughout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE_BIN="${FORGE_BIN:-$ROOT/forge/astra-forge/target/debug/astra-forge}"
ENGINE="$ROOT/engine"
TMP="${TMPDIR:-/tmp}/forge-roundtrip-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ ! -x "$FORGE_BIN" ]; then
  echo "roundtrip: building forge..." >&2
  (cd "$ROOT/forge/astra-forge" && cargo build --offline) >&2
fi

BASE="$(git -C "$ENGINE" log --format=%H --grep=^baseline: | tail -n 1)"
if [ -z "$BASE" ]; then
  BASE="$(git -C "$ENGINE" rev-list --max-parents=0 HEAD | head -n 1)"
fi
echo "roundtrip: baseline ${BASE:0:12}"

# 1. export regenerates patch bodies from the live tree (must be a no-op
#    when the series is already in sync, and must succeed).
PATCH_SUM_BEFORE="$(sha256sum "$ROOT"/patches/*.patch | sha256sum)"
(cd "$ROOT" && "$FORGE_BIN" export)
PATCH_SUM_AFTER="$(sha256sum "$ROOT"/patches/*.patch | sha256sum)"
if [ "$PATCH_SUM_BEFORE" != "$PATCH_SUM_AFTER" ]; then
  echo "roundtrip: FAIL: export rewrote patch bodies on an in-sync tree" >&2
  (cd "$ROOT" && git diff --stat -- patches/) >&2
  exit 1
fi
echo "roundtrip: export is a no-op on in-sync series"

# Volatile build debris (Firefox purge markers, objdirs) must not fail the
# comparison: other workers may be building/running while this test runs.
snapshot_sums() {
  (cd "$ROOT" && find engine -path 'engine/.git' -prune -o -type f -print0 \
    | sort -z | tr '\0' '\n' \
    | grep -v -e '^engine/obj-' -e '\.purgecaches$' -e '^engine/\.moz' \
    | tr '\n' '\0' | xargs -0 sha256sum)
}

# 2. snapshot the applied tree.
git -C "$ENGINE" diff "$BASE" -- . > "$TMP/before.diff"
snapshot_sums > "$TMP/before.sums"
if [ ! -s "$TMP/before.diff" ]; then
  echo "roundtrip: FAIL: no engine drift vs baseline; nothing to round-trip" >&2
  exit 1
fi
echo "roundtrip: snapshot $(wc -l < "$TMP/before.diff") diff lines, $(wc -l < "$TMP/before.sums") files"

# 3. reset tracked upstream files to baseline (keep untracked overlay output).
git -C "$ENGINE" checkout -q "$BASE" -- . && git -C "$ENGINE" reset -q
if git -C "$ENGINE" diff --quiet "$BASE" -- .; then
  echo "roundtrip: engine/ reset to baseline"
else
  echo "roundtrip: FAIL: reset left drift" >&2
  exit 1
fi
# Patches must now classify as clean (not already-applied).
(cd "$ROOT" && "$FORGE_BIN" lint)

# 4. import restores the tree (exercises the 3-way path via git apply).
(cd "$ROOT" && "$FORGE_BIN" import)
git -C "$ENGINE" diff "$BASE" -- . > "$TMP/after.diff"
snapshot_sums > "$TMP/after.sums"

# 5. byte-identical?
if ! cmp -s "$TMP/before.diff" "$TMP/after.diff"; then
  echo "roundtrip: FAIL: engine diff differs after import" >&2
  diff "$TMP/before.diff" "$TMP/after.diff" | head -40 >&2
  exit 1
fi
if ! cmp -s "$TMP/before.sums" "$TMP/after.sums"; then
  echo "roundtrip: FAIL: engine file checksums differ after import" >&2
  diff "$TMP/before.sums" "$TMP/after.sums" | head -20 >&2
  exit 1
fi

# 6. health report + footprint budget green after the cycle.
test -f "$ROOT/out/patch-health.json"
(cd "$ROOT" && "$FORGE_BIN" footprint)
(cd "$ROOT" && "$FORGE_BIN" lint > /dev/null)

echo "roundtrip: PASS (export->reset->import yields identical tree)"
