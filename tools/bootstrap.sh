#!/usr/bin/env bash
# Bootstrap a source checkout of Astra: build forge, fetch the pinned Firefox
# ESR tree, build the UI bundle, overlay the patch series, build the browser.
#
#   ./tools/bootstrap.sh              # full setup (incremental when re-run)
#   JOBS=8 ./tools/bootstrap.sh       # raise build parallelism (default 2)
#   ./tools/bootstrap.sh --skip-ui    # do not rebuild the chrome bundle
#   ./tools/bootstrap.sh --skip-build # stop after overlay (fetch + config + UI)
#
# Prerequisites: git, curl, tar, gpg, patch, python3, cargo, and Mozilla's
# release key for the tarball signature:
#   gpg --keyserver hkps://keyserver.ubuntu.com \
#       --recv-keys 14F26682D0916CDD81E37B6D61B7B526D98F0353
# Firefox build dependencies (clang, GTK3, dbus-glib, ALSA, ...) come from
#   (cd engine && ./mach bootstrap --application-choice=browser)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${JOBS:-2}"
SKIP_UI=0
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --skip-ui) SKIP_UI=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bootstrap: unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
die()  { echo "bootstrap: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing '$1' — $2"
}

step "checking prerequisites"
need git "install git"
need curl "install curl"
need tar "install tar"
need gpg "install gnupg"
need patch "install patch"
need python3 "install python3"
need cargo "install Rust from https://rustup.rs"
echo "bootstrap: tools OK (jobs=$JOBS)"

step "building astra-forge"
cargo build --release --manifest-path "$ROOT/forge/astra-forge/Cargo.toml"
FORGE="$ROOT/forge/astra-forge/target/release/astra-forge"
"$FORGE" doctor || true

step "fetching pinned upstream (Firefox ESR 153.6.0)"
if ! gpg --list-keys 14F26682D0916CDD81E37B6D61B7B526D98F0353 >/dev/null 2>&1; then
  echo "bootstrap: warning: Mozilla release key not imported; the tarball" >&2
  echo "bootstrap: signature check will fail. Import it with:" >&2
  echo "  gpg --keyserver hkps://keyserver.ubuntu.com --recv-keys 14F26682D0916CDD81E37B6D61B7B526D98F0353" >&2
fi
"$FORGE" fetch

step "rendering the mozconfig"
"$FORGE" config --os linux --branding astra

if [ "$SKIP_UI" = 0 ]; then
  if command -v bun >/dev/null 2>&1; then
    step "building the chrome UI bundle"
    ( cd "$ROOT/ui" && bun install --frozen-lockfile )
    ( cd "$ROOT/ui" && bun run --filter @astra/frame build:chrome )
  else
    echo "bootstrap: bun not found — the chrome bundle is generated, not committed;" >&2
    echo "bootstrap: run ./setup.sh (installs Bun) or install Bun (https://bun.sh)" >&2
    exit 1
  fi
fi

step "applying overlay + patch series"
"$FORGE" overlay

if [ "$SKIP_BUILD" = 1 ]; then
  step "done (build skipped)"
  exit 0
fi

step "building the engine (jobs=$JOBS)"
"$FORGE" build --jobs "$JOBS"

step "done"
echo "binary: $ROOT/engine/obj-astra-linux/dist/bin/firefox"
echo "run:    $ROOT/tools/run-dev.sh"
