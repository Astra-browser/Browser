#!/usr/bin/env bash
# Full verification: contracts, UI checks, every live browser probe, then the
# performance benches. Headed (private Weston display), never headless.
#
# Usage: tools/perf/full-suite.sh [--skip-build] [--skip-perf]
# Exit 0 when every gate passes; a probe that cannot run in this environment
# (media audio has no device) exits 2 and is reported as SKIP, not failure.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
fail=0
skip=0

skip_build=0
skip_perf=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --skip-perf) skip_perf=1 ;;
  esac
done

if [ "$skip_build" -eq 0 ]; then
  echo "== build: UI bundles + overlay + engine"
  (cd ui && bun run --filter @astra/shell-hello build && bun run --filter @astra/frame build:chrome) || exit 1
  (cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster) || exit 1
fi

echo "== contracts"
CONTRACTS=(
  hostapi_v1 shell_assembly frame_model tab_lifecycle stage_rect tabs_admission
  dialogs_events dialogs_security dialog_prompts_auth dialog_prompts_cert
  permissions_prompt operations_ledger metadata_restore page_source_model
  media_model webext_view wire_coverage containers_isolation
)
for t in "${CONTRACTS[@]}"; do
  if [ -f "tests/contract/$t.mjs" ]; then
    if node "tests/contract/$t.mjs" >"/tmp/full-$t.log" 2>&1; then
      echo "PASS $t"
    else
      echo "FAIL $t (see /tmp/full-$t.log)"
      fail=1
    fi
  fi
done

echo "== UI checks"
(cd ui && bun run --filter @astra/frame check) || fail=1
node --test ui/shell/src >/tmp/full-shell-tests.log 2>&1 || { echo "FAIL shell unit tests"; fail=1; }

echo "== live probes"
PROBES=(
  "shell_app_chrome:tests/contract/shell_app_chrome.py"
  "stage:tools/perf/stress/gbrowser_stage_probe.py"
  "tabs:tools/perf/stress/gbrowser_tabs_probe.py"
  "p43:tools/perf/stress/gbrowser_p43_probe.py"
  "multiwindow:tools/perf/stress/gbrowser_multiwindow_probe.py"
  "sessionstore:tools/perf/stress/sessionstore_probe.py"
  "containers_space:tools/perf/stress/containers_space_probe.py"
  "containers_private:tools/perf/stress/containers_private_move_probe.py"
  "native_nav:tools/perf/stress/native_nav_probe.py"
  "native_windows:tools/perf/stress/native_windows_probe.py"
  "permissions_store:tools/perf/stress/permissions_store_probe.py"
  "permission_prompt:tools/perf/stress/permission_prompt_probe.py"
  "webrtc:tools/perf/stress/webrtc_permission_probe.py"
  "metadata_restore:tools/perf/stress/metadata_restore_probe.py"
  "metadata_owner:tools/perf/stress/metadata_owner_probe.py"
  "page_source:tools/perf/stress/page_source_probe.py"
  "certificate:tools/perf/stress/certificate_probe.py"
  "http_auth:tools/perf/stress/http_auth_probe.py"
  "media:tools/perf/stress/media_player_probe.py"
)
for entry in "${PROBES[@]}"; do
  name="${entry%%:*}"
  path="${entry#*:}"
  start=$SECONDS
  ASTRA_METADATA_AUTODETECT=1 timeout 420 tools/perf/hidden-display.sh python3 "$path" \
    >"/tmp/full-$name.json" 2>"/tmp/full-$name.err"
  rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "SKIP $name (environment; $((SECONDS-start))s)"
    skip=$((skip+1))
  elif [ "$rc" -ne 0 ]; then
    echo "FAIL $name (rc=$rc, $((SECONDS-start))s; /tmp/full-$name.json)"
    fail=1
  else
    echo "PASS $name ($((SECONDS-start))s)"
  fi
done

if [ "$skip_perf" -eq 0 ]; then
  echo "== performance benches"
  if ! python3 tools/perf/run_all.py --runs 1 --out "$ROOT/out/perf-full-suite" 2>&1 | tee /tmp/full-perf.log | tail -12; then
    echo "WARN performance benches reported a failure (see /tmp/full-perf.log)"
  fi
fi

echo "== lint/state"
python3 tools/state-check.py || fail=1
bash tools/brand-lint.sh || fail=1

if [ "$fail" -ne 0 ]; then
  echo "FULL SUITE: FAIL"
  exit 1
fi
echo "FULL SUITE: PASS (${skip} skipped by environment)"
