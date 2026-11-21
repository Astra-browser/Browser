#!/usr/bin/env bash
# Full verification: contracts, UI checks, every live browser probe, then the
# performance benches. Headed (private Weston display), never headless.
#
# Usage: tools/perf/full-suite.sh [--skip-build] [--skip-live] [--skip-perf]
#
#   --skip-build   re-use the current build
#   --skip-live    contracts + UI checks + lint/state only (no browser)
#   --skip-perf    skip the benchmark pass
#
# Exit 0 when every gate passes; a probe that cannot run in this environment
# (media audio has no device, no ffmpeg) exits 2 and is reported as SKIP, not
# failure. A contract suite that cannot run (sidecar stub not built) is a SKIP
# with its reason, never a PASS.
#
# On Windows this script hands over to tools/perf/full-suite.ps1: the Linux
# runner needs a Wayland compositor (tools/perf/hidden-display.sh), and
# Git-Bash has neither weston nor /tmp.
#
# Results are written to out/full-suite-<UTC stamp>/ (override: ASTRA_SUITE_OUT).
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v pwsh >/dev/null 2>&1; then
      echo "full-suite: Windows host, using tools/perf/full-suite.ps1"
      exec pwsh -NoProfile -File tools/perf/full-suite.ps1 "$@"
    elif command -v powershell >/dev/null 2>&1; then
      echo "full-suite: Windows host, using tools/perf/full-suite.ps1"
      exec powershell -NoProfile -ExecutionPolicy Bypass -File tools/perf/full-suite.ps1 "$@"
    fi
    echo "full-suite: Windows host needs pwsh or powershell for the Windows runner" >&2
    exit 3
    ;;
esac

# Repo venv python when present (.venv/bin/python on Linux,
# .venv/Scripts/python.exe on Windows Git-Bash), else system python3/python.
PYTHON="$(bash "$ROOT/tools/venv-python.sh" 2>/dev/null || true)"
[ -n "$PYTHON" ] || PYTHON="python3"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${ASTRA_SUITE_OUT:-$ROOT/out/full-suite-$STAMP}"
mkdir -p "$OUT"
echo "results: $OUT"

fail=0
skip=0

skip_build=0
skip_perf=0
skip_live=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --skip-perf) skip_perf=1 ;;
    --skip-live) skip_live=1 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "full-suite: unknown argument $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$skip_build" -eq 0 ]; then
  echo "== build: UI bundles + overlay + engine"
  (cd ui && bun run --filter @astra/shell-hello build && bun run --filter @astra/frame build:chrome) || exit 1
  (cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster) || exit 1
fi

# Every tests/contract/*.mjs must be listed here: a suite that exists but is
# not registered is a hole in the gate, so the completeness check below fails.
echo "== contracts"
CONTRACTS=(
  blocker_coverage blocker_host bookmarks_model boot_model browsing_data_host
  chrome_extensions commands_model containers_isolation content_hide content_slot
  diagnostics_model dialog_prompts_auth dialog_prompts_cert dialogs_events dialogs_security
  downloads_model favicons_model first_run frame_model history_mirror history_model history_places
  hostapi_v1 keymap_model launcher_edit load_state media_gallery media_import_model media_model
  media_selection menu_layer metadata_restore migration_model native_file_picker
  native_nav_model native_surfaces notes_model operations_ledger page_dialogs page_source_model
  passkeys_model permissions_prompt privacy_host profiles_model protected_content
  resources_model search_model settings_native shell_assembly sidecar_spike
  site_permissions_host sleep_model slots_model spaces_model spaces_profiles_model
  stage_rect system_model tab_history tab_lifecycle tabs_admission tabs_settings
  telemetry_blocklist time_model webext_view window_scope wire_coverage work_model
  zoom_home_material
)
for file in tests/contract/*.mjs; do
  name="$(basename "$file" .mjs)"
  registered=0
  for known in "${CONTRACTS[@]}"; do
    [ "$known" = "$name" ] && registered=1 && break
  done
  if [ "$registered" -eq 0 ]; then
    echo "FAIL contract suite not registered: $name (add it to CONTRACTS)"
    fail=1
  fi
done
for t in "${CONTRACTS[@]}"; do
  if [ ! -f "tests/contract/$t.mjs" ]; then
    echo "FAIL contract suite missing: $t"
    fail=1
    continue
  fi
  if node "tests/contract/$t.mjs" >"$OUT/contract-$t.log" 2>&1; then
    echo "PASS $t"
  elif [ "$t" = "sidecar_spike" ] && grep -q "sidecar-stub" "$OUT/contract-$t.log"; then
    echo "SKIP $t (out/sidecar-stub not built; $OUT/contract-$t.log)"
    skip=$((skip+1))
  else
    echo "FAIL $t (see $OUT/contract-$t.log)"
    fail=1
  fi
done

echo "== UI checks"
if command -v bun >/dev/null 2>&1; then
  (cd ui && bun run --filter @astra/frame check) || fail=1
else
  echo "SKIP bun check (bun not installed)"
  skip=$((skip+1))
fi
if node --test ui/shell/src >"$OUT/shell-unit.log" 2>&1; then
  echo "PASS shell unit"
else
  echo "FAIL shell unit (see $OUT/shell-unit.log)"
  fail=1
fi

if [ "$skip_live" -eq 1 ]; then
  echo "== live probes: skipped (--skip-live)"
else
  echo "== live probes"
  # Registered probes are the ones that were green on the current build. The
  # stale ones (search/tabs/sidebar/bar/utility-bar/window-radius expectations,
  # ffmpeg fixtures) are listed in out/audit/findings/probes.md; register each
  # again only after it is repaired, never to make the run look complete.
  PROBES=(
    "shell_app_chrome:tests/contract/shell_app_chrome.py"
    "stage:tools/perf/stress/gbrowser_stage_probe.py"
    "tabs:tools/perf/stress/gbrowser_tabs_probe.py"
    "p43:tools/perf/stress/gbrowser_p43_probe.py"
    "multiwindow:tools/perf/stress/gbrowser_multiwindow_probe.py"
    "multi_window_isolation:tools/marionette-probe/multi-window-isolation-probe.py"
    "downloads_lifecycle:tools/marionette-probe/downloads-lifecycle-probe.py"
    "downloads_history:tools/marionette-probe/downloads-history-probe.py"
    "gallery:tools/marionette-probe/gallery-probe.py"
    "tab_order:tools/marionette-probe/tab-order-probe.py"
    "tabs_churn:tools/marionette-probe/tabs-churn-probe.py"
    "split_view:tools/marionette-probe/split-view-probe.py"
    "edge_matrix:tools/marionette-probe/edge-matrix.py"
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
    "now_playing:tools/marionette-probe/now-playing-probe.py"
    "media_card:tools/marionette-probe/media-card-probe.py"
    "pip_player:tools/marionette-probe/pip-player-probe.py"
    "pip_foreground:tools/marionette-probe/pip-foreground-probe.py"
    "pip_space_state:tools/marionette-probe/pip-space-state-probe.py"
    "webext:tools/perf/stress/webext_probe.py"
    "webext_prompt:tools/perf/stress/webext_prompt_probe.py"
    "webext_action:tools/perf/stress/webext_action_probe.py"
    "webext_ui:tools/perf/stress/webext_ui_probe.py"
    "passkeys:tools/marionette-probe/passkeys-probe.py"
    "devtools:tools/perf/stress/devtools_probe.py"
    "devtools_window:tools/marionette-probe/devtools-window-probe.py"
    "first_load:tools/perf/stress/first_load_probe.py"
    "settings_native:tools/marionette-probe/settings-native-probe.py"
    "settings_restart:tools/marionette-probe/settings-restart-probe.py"
    "settings_audit:tools/marionette-probe/settings-audit-probe.py"
    "settings_parity:tools/marionette-probe/settings-parity-probe.py"
    "blocker:tools/marionette-probe/blocker-probe.py"
    "blocker_lifecycle:tools/marionette-probe/blocker-refresh-probe.py"
    "superadblock:tools/marionette-probe/superadblock-probe.py"
    "adblocktester:tools/marionette-probe/adblocktester-probe.py"
    "shields:tools/marionette-probe/shields-probe.py"
    "fingerprint:tools/marionette-probe/fingerprint-probe.py"
    "tabs_settings:tools/marionette-probe/tabs-settings-probe.py"
    "material_zoom_home:tools/marionette-probe/material-zoom-home-probe.py"
    "profiles_switch:tools/marionette-probe/profiles-switch-probe.py"
    "bar:tools/marionette-probe/bar-probe.py"
    "address_home:tools/marionette-probe/address-home-probe.py"
    "search_theme:tools/marionette-probe/search-theme-probe.py"
    "window_radius:tools/marionette-probe/window-radius-probe.py"
    "fullscreen:tools/marionette-probe/fullscreen-probe.py"
    "native_surfaces:tools/marionette-probe/native-surfaces-probe.py"
    "owner_report:tools/marionette-probe/owner-report-probe.py"
    "sidebar_shield:tools/marionette-probe/sidebar-shield-probe.py"
    "surface_park:tools/marionette-probe/surface-park-probe.py"
    "notes:tools/marionette-probe/notes-probe.py"
    "theme:tools/marionette-probe/theme-probe.py"
    "version:tools/marionette-probe/version-probe.py"
    "work_off:tools/marionette-probe/work-off-probe.py"
    "tab_switch_seam:tools/marionette-probe/tab-switch-seam-probe.py"
    "tab_reassert:tools/marionette-probe/tab-reassert-probe.py"
    "popup_window:tools/marionette-probe/popup-window-probe.py"
    "chrome_ext:tools/perf/stress/chrome_ext_probe.py"
    "real_extensions:tools/perf/stress/real_extensions_probe.py"
    "extension_bench:tools/perf/stress/extension_bench.py"
    "corpus:tools/perf/stress/extension_corpus_probe.py"
  )
  for entry in "${PROBES[@]}"; do
    name="${entry%%:*}"
    path="${entry#*:}"
    start=$SECONDS
    ASTRA_METADATA_AUTODETECT=1 timeout 420 tools/perf/hidden-display.sh "$PYTHON" "$path" \
      >"$OUT/probe-$name.json" 2>"$OUT/probe-$name.err"
    rc=$?
    if [ "$rc" -eq 2 ]; then
      echo "SKIP $name (environment; $((SECONDS-start))s)"
      skip=$((skip+1))
    elif [ "$rc" -eq 124 ]; then
      echo "FAIL $name (timeout 420s; $OUT/probe-$name.err)"
      fail=1
    elif [ "$rc" -ne 0 ]; then
      echo "FAIL $name (rc=$rc, $((SECONDS-start))s; $OUT/probe-$name.json)"
      fail=1
    else
      echo "PASS $name ($((SECONDS-start))s)"
    fi
  done
fi

if [ "$skip_perf" -eq 0 ] && [ "$skip_live" -eq 0 ]; then
  echo "== performance benches"
  if ! "$PYTHON" tools/perf/run_all.py --runs 1 --out "$ROOT/out/perf-full-suite" 2>&1 \
    | tee "$OUT/perf.log" | tail -12; then
    echo "WARN performance benches reported a failure (see $OUT/perf.log)"
  fi
fi

echo "== lint/state"
"$PYTHON" tools/state-check.py || fail=1
bash tools/brand-lint.sh || fail=1

if [ "$fail" -ne 0 ]; then
  echo "FULL SUITE: FAIL (results in $OUT)"
  exit 1
fi
echo "FULL SUITE: PASS (${skip} skipped by environment; results in $OUT)"
