#!/usr/bin/env bash
# Run a headed command on a private Weston compositor.
#
# The browser still runs headed (no --headless), but its window lives on a
# throwaway Wayland display, so a test never appears on the owner's desktop or
# steals focus from whatever is on screen.
#
# Usage: tools/perf/hidden-display.sh <command> [args...]
set -euo pipefail

runtime="$(mktemp -d /tmp/astra-weston.XXXXXX)"
socket="astra-test-$$"
cleanup() {
  if [ -n "${wpid:-}" ]; then
    kill "$wpid" 2>/dev/null || true
    wait "$wpid" 2>/dev/null || true
  fi
  rm -rf "$runtime"
}
trap cleanup EXIT INT TERM

XDG_RUNTIME_DIR="$runtime" weston \
  --backend=headless --renderer=pixman --socket="$socket" \
  --width=1600 --height=1000 --no-config \
  >"$runtime/weston.log" 2>&1 &
wpid=$!

for _ in $(seq 1 80); do
  [ -S "$runtime/$socket" ] && break
  sleep 0.1
done
if [ ! -S "$runtime/$socket" ]; then
  echo "hidden-display: weston did not start" >&2
  cat "$runtime/weston.log" >&2 || true
  exit 1
fi

export XDG_RUNTIME_DIR="$runtime"
export WAYLAND_DISPLAY="$socket"
export MOZ_ENABLE_WAYLAND=1
export MOZ_CRASHREPORTER_DISABLE=1
export ASTRA_TEST_VIRTUAL=1
unset DISPLAY
"$@"
