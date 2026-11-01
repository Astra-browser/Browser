#!/bin/sh
# check-drift.sh (P2-T02): fail if generated files drift from their sources.
# Regenerates everything into a temp dir and diffs against the checked-in
# files, then runs the fixture validator, Rust tests, TS tests and a tsc
# type-check. Exit 1 on ANY failure (CI gate).
# Usage: crates/astra-proto/check-drift.sh        # check only
#        FIX=1 crates/astra-proto/check-drift.sh  # regenerate in place
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/crates/astra-proto"
TSC_VER="${TSC_VER:-7.0.2}"

if [ "${FIX:-0}" = "1" ]; then
  python3 "$CRATE/codegen/generate.py" --root "$ROOT"
  echo "drift: regenerated in place"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 "$CRATE/codegen/generate.py" --root "$ROOT" --out "$TMP" >/dev/null

FAIL=0
check() {
  if ! diff -q "$TMP/$1" "$ROOT/$1" >/dev/null 2>&1; then
    echo "drift: STALE: $1 (run FIX=1 $0 to regenerate)" >&2
    FAIL=1
  fi
}
check schemas/commands.json
check schemas/events.json
check crates/astra-proto/src/generated.rs
check crates/astra-proto/gen/astra-proto.ts
for f in "$TMP/crates/astra-proto/fixtures/commands/"*.json; do
  b="$(basename "$f")"
  check "crates/astra-proto/fixtures/commands/$b"
done
# No unexpected extra fixture files.
if [ "$(ls "$TMP/crates/astra-proto/fixtures/commands" | wc -l)" != \
     "$(ls "$CRATE/fixtures/commands" | wc -l)" ]; then
  echo "drift: STALE: fixture file set changed" >&2
  FAIL=1
fi

python3 "$CRATE/codegen/validate.py" || FAIL=1

cargo test --manifest-path "$CRATE/Cargo.toml" 2>&1 | tail -3 || FAIL=1

(cd "$CRATE" && bun test gen/) 2>&1 | tail -4 || FAIL=1

# Type-check the generated module (self-contained; the *.test.ts needs
# bun types, covered at runtime by `bun test` instead).
(cd "$CRATE" && npx --yes -p "typescript@$TSC_VER" tsc --noEmit \
  --strict --target es2022 --module esnext --moduleResolution bundler \
  gen/astra-proto.ts) || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "drift: FAILED" >&2
  exit 1
fi
echo "drift: clean (schemas + generated + fixtures + tests + tsc)"
