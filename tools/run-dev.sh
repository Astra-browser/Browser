#!/usr/bin/env bash
# Launch the Astra dev build (the binary `forge build` produces).
#
#   ./tools/run-dev.sh                 # reuse the dev profile (settings persist)
#   ./tools/run-dev.sh --fresh         # start from an empty profile
#   ./tools/run-dev.sh -- --new-window # anything after `--` goes to firefox
#
# The profile lives in out/dev-profile (git-ignored). One instance per profile:
# `-no-remote` makes a second launch reuse the running window instead of
# fighting over it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/engine/obj-astra-linux/dist/bin/firefox"
PROFILE="$ROOT/out/dev-profile"

fresh=0
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) fresh=1; shift ;;
    --) shift; extra=("$@"); break ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) extra+=("$1"); shift ;;
  esac
done

if [ ! -x "$BIN" ]; then
  echo "No dev build at $BIN" >&2
  echo "Build it first:" >&2
  echo "  (cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster)" >&2
  exit 1
fi

if [ "$fresh" = 1 ]; then
  rm -rf "$PROFILE"
  echo "fresh profile: $PROFILE"
fi
mkdir -p "$PROFILE"

# Run from the dist dir: the build resolves its own resources relative to it.
cd "$(dirname "$BIN")"
exec ./firefox -no-remote -profile "$PROFILE" "${extra[@]+"${extra[@]}"}" about:blank
