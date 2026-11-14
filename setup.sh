#!/usr/bin/env bash
# Astra one-command setup: dependencies, sources, patches, build, package.
#
#   ./setup.sh                 # full setup (deps + fetch + UI + engine + package)
#   JOBS=4 ./setup.sh          # engine build parallelism (default 2, OOM-safe)
#   ./setup.sh --skip-ui       # reuse the existing chrome bundle
#   ./setup.sh --skip-build    # stop after overlay (fetch + config + UI)
#   ./setup.sh --check         # verify this machine runs the packaged build
#
# Safe to re-run: every step is idempotent. Asks for the sudo password once
# up front and keeps it alive for the package installs below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo venv python when present (.venv/bin/python on Linux,
# .venv/Scripts/python.exe on Windows Git-Bash), else system python3/python.
PYTHON="$(bash "$ROOT/tools/venv-python.sh" 2>/dev/null || true)"
[ -n "$PYTHON" ] || PYTHON="python3"
JOBS="${JOBS:-2}"
SKIP_UI=0
SKIP_BUILD=0
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --skip-ui) SKIP_UI=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "setup.sh: unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
die() { echo "setup.sh: $*" >&2; exit 1; }

[ "$(uname -m)" = "x86_64" ] || die "x86_64-only (running on $(uname -m))"

# Read-only verify mode needs no sudo and no distro packages.
if [ "$CHECK_ONLY" = 1 ]; then
  STAGE="$ROOT/out/release/stage/Astra"
  [ -x "$STAGE/install.sh" ] || die "no packaged build yet (run ./setup.sh first)"
  bash "$STAGE/install.sh" --check-deps
  ( cd "$STAGE" && ./firefox --version )
  echo "setup.sh: this machine runs the packaged build"
  exit 0
fi

# --- sudo up front -----------------------------------------------------------
step "sudo (one password prompt for all installs below)"
sudo -v
# Keep the timestamp alive in the background; killed on exit.
( while true; do sudo -n true 2>/dev/null; sleep 50; kill -0 "$$" 2>/dev/null || exit; done ) &
KEEPALIVE_PID=$!
trap 'kill $KEEPALIVE_PID 2>/dev/null || true' EXIT

# --- distro detection ----------------------------------------------------------
DISTRO_ID="unknown"
DISTRO_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
  DISTRO_LIKE="${ID_LIKE:-}"
fi
FAMILY="unknown"
case " $DISTRO_ID $DISTRO_LIKE " in
  *"debian"*|*"ubuntu"*|*"mint"*|*"pop"*) FAMILY="debian" ;;
  *"fedora"*|*"rhel"*|*"centos"*|*"rocky"*|*"alma"*) FAMILY="fedora" ;;
  *"suse"*|*"opensuse"*) FAMILY="suse" ;;
  *"arch"*) FAMILY="arch" ;;
esac
echo "setup.sh: distro=$DISTRO_ID like='$DISTRO_LIKE' family=$FAMILY"
[ "$FAMILY" != "unknown" ] || die "unsupported distro (no /etc/os-release match for '$DISTRO_ID')"

# --- OS packages (build + runtime) ----------------------------------------------
step "installing OS packages ($FAMILY)"
case "$FAMILY" in
  debian)
    sudo apt-get update -y
    sudo apt-get install -y git curl tar ca-certificates gnupg patch python3 \
      pkg-config unzip xz-utils build-essential clang llvm nasm nodejs \
      libgtk-3-0 libdbus-1-3 libasound2 libx11-xcb1 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libfontconfig1 \
      fonts-liberation pipewire-pulse
    command -v sccache >/dev/null 2>&1 || sudo apt-get install -y sccache || true ;;
  fedora)
    sudo dnf install -y git curl tar ca-certificates gnupg2 patch python3 \
      pkgconf-pkg-config unzip xz gcc gcc-c++ make m4 clang llvm nasm nodejs \
      sccache gtk3 dbus-libs alsa-lib libXcomposite libXdamage libXfixes \
      libXrandr mesa-libgbm pango cairo fontconfig google-noto-sans-fonts \
      pipewire-pulseaudio || true ;;
  suse)
    sudo zypper --non-interactive install git curl tar ca-certificates gpg2 \
      patch python3 pkg-config unzip xz gcc gcc-c++ make clang llvm nasm \
      nodejs sccache gtk3 dbus-1 alsa libXcomposite1 libXdamage1 libXfixes3 \
      libXrandr2 mesa-libgbm pango cairo fontconfig liberation-fonts \
      pipewire-pulseaudio || true ;;
  arch)
    sudo pacman -Sy --needed --noconfirm git curl tar ca-certificates gnupg \
      patch python pkgconf unzip xz base-devel clang llvm nasm nodejs sccache \
      gtk3 dbus alsa-lib libxcomposite libxdamage libxfixes libxrandr mesa \
      pango cairo fontconfig ttf-liberation pipewire-pulse ;;
esac

# --- Rust / Bun ---------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  step "installing Rust (rustup, stable)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

if ! command -v bun >/dev/null 2>&1; then
  step "installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v sccache >/dev/null 2>&1; then
  echo "setup.sh: warning: sccache missing and the package install did not provide it;" >&2
  echo "setup.sh: the engine configure step (--with-ccache=sccache) needs it." >&2
fi

# Mozilla release key for the upstream tarball signature (best effort;
# `forge fetch` verifies when the .asc is present and warns otherwise).
if ! gpg --list-keys 14F26682D0916CDD81E37B6D61B7B526D98F035 >/dev/null 2>&1; then
  gpg --keyserver hkps://keyserver.ubuntu.com \
      --recv-keys 14F26682D0916CDD81E37B6D61B7B526D98F035 2>/dev/null || true
fi

# Hide the builder's absolute paths from the shipped Rust sidecar. Panic
# locations embed source paths at compile time; strip(1) cannot remove those.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~ --remap-path-prefix=$ROOT=."

# --- forge ---------------------------------------------------------------------
step "building astra-forge"
cargo build --release --manifest-path "$ROOT/forge/astra-forge/Cargo.toml"
FORGE="$ROOT/forge/astra-forge/target/release/astra-forge"

step "fetching pinned upstream"
"$FORGE" fetch

step "rendering mozconfig"
"$FORGE" config --os linux --branding astra

# Mozilla's own build-dependency bootstrap (authoritative for the engine;
# best effort — our package list above covers the common cases already).
if [ -x "$ROOT/engine/mach" ]; then
  step "engine build dependencies (mach bootstrap, best effort)"
  ( cd "$ROOT/engine" && MOZCONFIG="$ROOT/out/mozconfig.linux" \
    "$PYTHON" ./mach bootstrap --application-choice=browser --no-interactive ) || {
    echo "setup.sh: warning: mach bootstrap incomplete; the engine build will report what is missing" >&2
  }
fi

# --- UI --------------------------------------------------------------------------
if [ "$SKIP_UI" = 0 ]; then
  step "building the chrome UI bundle"
  ( cd "$ROOT/ui" && bun install --frozen-lockfile )
  ( cd "$ROOT/ui" && bun run --filter @astra/frame build:chrome )
else
  echo "setup.sh: skipping UI build (--skip-ui)"
fi

# --- overlay + engine --------------------------------------------------------------
step "applying overlay + patch series"
"$FORGE" overlay

if [ "$SKIP_BUILD" = 1 ]; then
  step "done (build skipped)"
  echo "binary (stale): $ROOT/engine/obj-astra-linux/dist/bin/firefox"
  exit 0
fi

step "building the engine (jobs=$JOBS)"
"$FORGE" build --jobs "$JOBS"

# --- package -----------------------------------------------------------------------
step "packaging"
"$ROOT/tools/package-release.sh"

step "verifying the package on this machine"
STAGE="$ROOT/out/release/stage/Astra"
bash "$STAGE/install.sh" --check-deps
( cd "$STAGE" && ./firefox --version )

step "done"
echo "package:  $(ls -1t "$ROOT"/out/release/Astra-*-linux-x86_64.tar.xz | head -1)"
echo "run:      $ROOT/tools/run-dev.sh"
echo "install:  (extract the tarball) ./install.sh  |  sudo ./install.sh --system"
