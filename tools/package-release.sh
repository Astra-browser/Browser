#!/usr/bin/env bash
# Build an installable Astra release from the current engine build.
#
#   tools/package-release.sh              # package the existing dist/ build
#   tools/package-release.sh --with-build # build the engine first (overlay + build --faster)
#
# Output: out/release/Astra-<ver>-linux-x86_64.tar.xz
#         out/release/Astra-<ver>-linux-x86_64.tar.xz.sha256
#
# The archive contains the portable browser, the astra-core sidecar, an
# install.sh (per-user or --system), launcher, icons and desktop entry.
#
# Assumes the UI was built with the Work flag off (the default):
#   bun run --filter @astra/frame build:chrome
#
# The packaging manifest needs three Astra entries that upstream only ships
# for Mozilla-built packages. This script patches the ignored engine tree
# idempotently so a fresh `forge fetch` tree can be packaged the same way.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Repo venv python when present (.venv/bin/python on Linux,
# .venv/Scripts/python.exe on Windows Git-Bash), else system python3/python.
PYTHON="$(bash "$ROOT/tools/venv-python.sh" 2>/dev/null || true)"
[ -n "$PYTHON" ] || PYTHON="python3"
FORGE="$ROOT/forge/astra-forge/target/release/astra-forge"
if [ ! -x "$FORGE" ]; then
  FORGE="$ROOT/forge/astra-forge/target/debug/astra-forge"
fi
if [ ! -x "$FORGE" ]; then
  echo "== building astra-forge"
  cargo build --release --manifest-path "$ROOT/forge/astra-forge/Cargo.toml"
  FORGE="$ROOT/forge/astra-forge/target/release/astra-forge"
fi
DIST="$ROOT/engine/obj-astra-linux/dist"
MOZCONFIG="$ROOT/out/mozconfig.linux"
RELEASE="$ROOT/out/release"
BRAND="$ROOT/overlay/astra/branding"

# Astra's own build version, from the single source of truth. This is what
# testers see; the engine pin (`VERSION` below) stays the Firefox version.
ASTRA_VERSION="$(sed -nE 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"?([^"#]+)"?[[:space:]]*$/\1/p' "$ROOT/branding/astra.toml" | head -n1 | tr -d '[:space:]')"
[ -n "$ASTRA_VERSION" ] || {
  echo "branding/astra.toml has no version" >&2
  exit 1
}

with_build=0
[ "${1:-}" = "--with-build" ] && with_build=1

if [ "$with_build" = 1 ]; then
  echo "== stage overlay + build (--faster)"
  ( cd "$ROOT" && "$FORGE" overlay )
  ( cd "$ROOT" && "$FORGE" build --faster --jobs 2 )
fi

[ -x "$DIST/bin/firefox" ] || {
  echo "no build at $DIST/bin — run: tools/package-release.sh --with-build" >&2
  exit 1
}

echo "== packaging manifest fixes"
"$PYTHON" - "$ROOT" <<'PY'
import sys
from pathlib import Path

engine = Path(sys.argv[1]) / "engine"
manifest = engine / "browser/installer/package-manifest.in"
text = manifest.read_text()

if "astra-branding.js" not in text:
    text = text.replace(
        "@RESPATH@/browser/@PREF_DIR@/firefox-branding.js",
        "@RESPATH@/browser/@PREF_DIR@/astra-branding.js",
    )

marker = "; Astra overlay + sidecar"
if marker not in text:
    text += f"""
{marker}
@RESPATH@/chrome/astra.manifest
@RESPATH@/chrome/astra/*
@RESPATH@/mozilla.cfg
@RESPATH@/defaults/pref/local-settings.js
@RESPATH@/distribution/*
@RESPATH@/astra-core
"""
manifest.write_text(text)

defs = engine / "astra/defs.mk"
if not defs.exists():
    defs.write_text("XPI_ROOT_APPID=$(MOZ_APP_ID)\n")
PY

echo "== mach package"
if command -v strip >/dev/null 2>&1 && [ -f "$DIST/bin/astra-core" ]; then
  # The sidecar ships in the archive: drop debug symbols. (Panic-location
  # paths are baked at compile time — those need RUSTFLAGS --remap-path-prefix,
  # which setup.sh exports; strip cannot remove them.)
  strip --strip-unneeded "$DIST/bin/astra-core" 2>/dev/null || true
fi
( cd "$ROOT/engine" && MOZCONFIG="$MOZCONFIG" SCCACHE_DIR="$ROOT/out/sccache" ./mach package )

SRC_TARBALL="$(ls -1 "$DIST"/firefox-*.en-US.linux-x86_64.tar.xz | head -1)"
VERSION="$(basename "$SRC_TARBALL" | sed -E 's/^firefox-([0-9.]+)\..*/\1/')"
NAME="Astra-$ASTRA_VERSION-linux-x86_64"
STAGE="$RELEASE/stage"
APP="$STAGE/Astra"

rm -rf "$STAGE" "$RELEASE/$NAME.tar.xz" "$RELEASE/$NAME.tar.xz.sha256"
mkdir -p "$APP"

echo "== extract $SRC_TARBALL"
tar -xf "$SRC_TARBALL" -C "$APP" --strip-components=1

echo "== icons and launcher"
mkdir -p "$APP/package/icons"
for size in 16 32 48 64 128; do
  cp "$BRAND/default${size}.png" "$APP/package/icons/astra-${size}.png"
done
cp "$BRAND/astra-icon-512.png" "$APP/package/icons/astra-512.png"

cat > "$APP/package/astra" <<'WRAPPER'
#!/bin/sh
# Astra launcher: private profile, Wayland when available.
if [ "$(uname -m)" != "x86_64" ]; then
  echo "astra: this build is x86_64-only (running on $(uname -m))" >&2
  exit 1
fi
SELF=$(readlink -f "$0")
PROFILE="${ASTRA_PROFILE:-$HOME/.mozilla/astra}"
for arg in "$@"; do
  [ "$arg" = "-profile" ] && exec "$(dirname "$SELF")/../firefox" "$@"
done
mkdir -p "$PROFILE"
if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -z "${MOZ_ENABLE_WAYLAND:-}" ]; then
  export MOZ_ENABLE_WAYLAND=1
fi
exec "$(dirname "$SELF")/../firefox" -profile "$PROFILE" "$@"
WRAPPER
chmod 755 "$APP/package/astra"

cat > "$APP/package/astra.desktop.in" <<'DESKTOP'
[Desktop Entry]
Version=1.0
Name=Astra
GenericName=Web Browser
Comment=Browse the web with Astra
Exec=@EXEC@ %u
Icon=astra
Terminal=false
Type=Application
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true
StartupWMClass=astra-nightly
Categories=Network;WebBrowser;
Keywords=web;browser;internet;
DESKTOP

echo "== apparmor profile template (Ubuntu 24.04+ userns)"
mkdir -p "$APP/package/apparmor"
cat > "$APP/package/apparmor/astra.in" <<'APPARMOR'
# Astra AppArmor profile template. install.sh renders @PREFIX@ to the real
# install path and loads it as /etc/apparmor.d/astra (needs sudo once).
# Without this, Ubuntu 24.04+ (kernel.apparmor_restrict_unprivileged_userns=1)
# denies unprivileged user namespaces and the content sandbox degrades.
abi <abi/4.0>,
include <tunables/global>
profile astra @PREFIX@/firefox flags=(unconfined) {
  userns,
  include if exists <local/astra>
}
APPARMOR

echo "== install script"
cat > "$APP/install.sh" <<'INSTALL'
#!/usr/bin/env bash
# Install Astra for the current user.
#
#   ./install.sh                     -> ~/.local/opt/astra + ~/.local/bin/astra
#   sudo ./install.sh --system       -> /usr/local/opt/astra
#   ./install.sh --check-deps        -> verify system libraries, then exit
#   ./install.sh --skip-deps         -> skip the library check
#
# The browser folder is copied, so the downloaded/extracted folder can be
# deleted afterwards. Run uninstall.sh from the install directory to remove it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="$HOME/.local/opt/astra"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share"
SYSTEM=0
CHECK_ONLY=0
SKIP_DEPS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --system)
      SYSTEM=1
      PREFIX="/usr/local/opt/astra"
      BIN_DIR="/usr/local/bin"
      DATA_DIR="/usr/local/share"
      shift ;;
    --check-deps) CHECK_ONLY=1; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --help|-h) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -m)" != "x86_64" ]; then
  echo "install.sh: this build is x86_64-only (running on $(uname -m))" >&2
  exit 1
fi

# --- dependency check ------------------------------------------------------
# Required shared libraries (DT_NEEDED of the shipped binaries, system side).
REQUIRED_LIBS="libgtk-3.so.0 libdbus-1.so.3 libasound.so.2 libX11.so.6 libXcomposite.so.1 libXdamage.so.1 libXfixes.so.3 libXrandr.so.2"

distro_install_hint() {
  local id="" like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    id="${ID:-}"; like="${ID_LIKE:-}"
  fi
  case " $id $like " in
    *"debian"*|*"ubuntu"*|*"mint"*|*"pop"*)
      echo "  sudo apt install libgtk-3-0 libdbus-1-3 libasound2 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libfontconfig1 fonts-liberation pipewire-pulse" ;;
    *"fedora"*|*"rhel"*|*"centos"*|*"rocky"*|*"alma"*)
      echo "  sudo dnf install gtk3 dbus-libs alsa-lib libXcomposite libXdamage libXfixes libXrandr mesa-libgbm pango cairo fontconfig google-noto-sans-fonts pipewire-pulseaudio" ;;
    *"suse"*|*"opensuse"*)
      echo "  sudo zypper in gtk3 dbus-1 alsa libXcomposite1 libXdamage1 libXfixes3 libXrandr2 mesa-libgbm pango cairo fontconfig liberation-fonts pipewire-pulseaudio" ;;
    *"arch"*)
      echo "  sudo pacman -S gtk3 dbus alsa-lib libxcomposite libxdamage libxfixes libxrandr mesa pango cairo fontconfig ttf-liberation pipewire-pulse" ;;
    *) echo "  install GTK 3, dbus, ALSA, X11/Xcomposite/Xdamage/Xfixes/Xrandr, mesa-libgbm, pango, cairo, fontconfig and a text font (your distro's Firefox dependency list covers it)" ;;
  esac
}

check_deps() {
  local missing=0 cache=""
  cache="$(ldconfig -p 2>/dev/null || true)"
  local lib
  for lib in $REQUIRED_LIBS; do
    if ! grep -q "$lib" <<<"$cache"; then
      echo "install.sh: missing $lib" >&2
      missing=1
    fi
  done
  # libstdc++ floor: the browser needs GCC 9 (GLIBCXX_3.4.26). ML features
  # need GCC 12 (GLIBCXX_3.4.30) and degrade gracefully without it.
  # NOTE: grep -c (not grep -q): under `set -o pipefail` an early-exiting
  # grep -q races strings into SIGPIPE and the check misfires.
  local stdcpp n26=0
  stdcpp="$(grep 'libstdc++.so.6' <<<"$cache" | grep -i 'x86-64' | head -1 | sed 's/.*=>[[:space:]]*//')"
  [ -n "$stdcpp" ] || stdcpp="$(grep -m1 'libstdc++.so.6' <<<"$cache" | sed 's/.*=>[[:space:]]*//')"
  if [ -n "$stdcpp" ]; then
    n26="$(strings "$stdcpp" 2>/dev/null | grep -c 'GLIBCXX_3\.4\.26' || true)"
  fi
  if [ -n "$stdcpp" ] && [ "$n26" = 0 ]; then
    echo "install.sh: libstdc++ predates GCC 9 — this build will not start" >&2
    missing=1
  fi
  if [ "$missing" = 1 ]; then
    echo "install.sh: install the missing libraries, then retry:" >&2
    distro_install_hint >&2
    return 1
  fi
  echo "install.sh: system libraries OK"
}

if [ "$SKIP_DEPS" = 0 ]; then
  check_deps || { echo "install.sh: re-run with --skip-deps to install anyway" >&2; exit 1; }
fi
if [ "$CHECK_ONLY" = 1 ]; then exit 0; fi

if [ "$SYSTEM" = 1 ] && [ "$(id -u)" != 0 ]; then
  echo "--system needs root: sudo ./install.sh --system" >&2
  exit 1
fi

echo "installing to $PREFIX"
mkdir -p "$(dirname "$PREFIX")" "$BIN_DIR" "$DATA_DIR/applications"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
cp -a "$HERE/." "$PREFIX"/

ln -sfn "$PREFIX/package/astra" "$BIN_DIR/astra"

sed "s|@EXEC@|$PREFIX/package/astra|" "$HERE/package/astra.desktop.in" \
  > "$DATA_DIR/applications/astra.desktop"
chmod 644 "$DATA_DIR/applications/astra.desktop"

for size in 16 32 48 64 128 512; do
  dir="$DATA_DIR/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  cp "$HERE/package/icons/astra-${size}.png" "$dir/astra.png"
done

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$DATA_DIR/applications" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -q -t "$DATA_DIR/icons/hicolor" 2>/dev/null || true

# SELinux (Fedora/RHEL): label the new tree; warn-only.
command -v restorecon >/dev/null 2>&1 && \
  restorecon -R "$PREFIX" 2>/dev/null || true

# AppArmor (Ubuntu 24.04+): the kernel denies unprivileged user namespaces to
# unconfined processes, which degrades the content sandbox. Loading this
# profile needs sudo once; best-effort and warn-only.
install_apparmor_profile() {
  command -v apparmor_parser >/dev/null 2>&1 || return 0
  [ -f "$HERE/package/apparmor/astra.in" ] || return 0
  sed "s|@PREFIX@|$PREFIX|" "$HERE/package/apparmor/astra.in" > /etc/apparmor.d/astra
  apparmor_parser -r /etc/apparmor.d/astra 2>/dev/null || return 0
  echo "$PREFIX" > "$PREFIX/.apparmor-profile"
  echo "install.sh: AppArmor profile loaded (/etc/apparmor.d/astra)"
}
if [ "$(id -u)" = 0 ]; then
  install_apparmor_profile || echo "install.sh: warning: AppArmor profile not loaded (sandbox degrades on Ubuntu 24.04+)" >&2
elif command -v apparmor_parser >/dev/null 2>&1; then
  echo "install.sh: note: AppArmor present but no profile loaded (needs sudo; sandbox degrades on Ubuntu 24.04+ until loaded)" >&2
fi

cat > "$PREFIX/uninstall.sh" <<UNINSTALL
#!/usr/bin/env bash
set -euo pipefail
PREFIX="$PREFIX"
BIN_DIR="$BIN_DIR"
DATA_DIR="$DATA_DIR"
[ -L "\$BIN_DIR/astra" ] && rm -f "\$BIN_DIR/astra"
rm -f "\$DATA_DIR/applications/astra.desktop"
for size in 16 32 48 64 128 512; do
  rm -f "\$DATA_DIR/icons/hicolor/\${size}x\${size}/apps/astra.png"
done
if [ -f "\$PREFIX/.apparmor-profile" ] && [ -f /etc/apparmor.d/astra ] && grep -q "\$PREFIX/firefox" /etc/apparmor.d/astra 2>/dev/null; then
  if [ "\$(id -u)" = 0 ]; then rm -f /etc/apparmor.d/astra; else echo "uninstall: remove /etc/apparmor.d/astra with sudo" >&2; fi
fi
rm -rf "\$PREFIX"
echo "Astra removed."
UNINSTALL
chmod 755 "$PREFIX/uninstall.sh"

echo
echo "Astra installed."
echo "  run:     astra            (or $PREFIX/package/astra)"
echo "  remove:  $PREFIX/uninstall.sh"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  note:    add $BIN_DIR to PATH to run 'astra' directly" ;;
esac
INSTALL
chmod 755 "$APP/install.sh"

cat > "$APP/README.md" <<'README'
# Astra (installable build)

This is a portable Linux x86_64 build of Astra. It is the full product build:
ad/tracker blocking, spaces, split view, PiP, notes, extensions, protected
content and the Astra interface. Work is **off** in this build (Beta 1 rule).

## Install

```sh
./install.sh                 # per-user: ~/.local/opt/astra, launcher in ~/.local/bin
sudo ./install.sh --system   # system-wide: /usr/local/opt/astra
```

Then launch `astra`, or pick **Astra** from your application menu. The
extracted folder can be deleted after installing.

To remove it, run the `uninstall.sh` written into the install directory.

## Run without installing

```sh
./package/astra
```

## Requirements

x86_64 CPU, Linux kernel 4.4+, glibc 2.34+, and an X11 or Wayland session.
No Node, Rust or compiler is needed to run this build.

Supported: Ubuntu 22.04+/24.04, Debian 12+, Fedora 36+, RHEL/Rocky/Alma 9,
openSUSE Leap 15.6+/Tumbleweed, Arch.

System libraries (the same set a Firefox ESR 153 build needs, plus a text
font and PipeWire/PulseAudio for sound):

```sh
# Ubuntu / Debian / Mint / Pop!_OS
sudo apt install libgtk-3-0 libdbus-1-3 libasound2 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libfontconfig1 fonts-liberation pipewire-pulse

# Fedora / RHEL / Rocky / Alma
sudo dnf install gtk3 dbus-libs alsa-lib libXcomposite libXdamage libXfixes \
  libXrandr mesa-libgbm pango cairo fontconfig google-noto-sans-fonts \
  pipewire-pulseaudio

# openSUSE
sudo zypper in gtk3 dbus-1 alsa libXcomposite1 libXdamage1 libXfixes3 \
  libXrandr2 mesa-libgbm pango cairo fontconfig liberation-fonts \
  pipewire-pulseaudio

# Arch / CachyOS / Manjaro
sudo pacman -S gtk3 dbus alsa-lib libxcomposite libxdamage libxfixes \
  libxrandr mesa pango cairo fontconfig ttf-liberation pipewire-pulse
```

`./install.sh` verifies these before installing (`./install.sh --check-deps`
checks only, `--skip-deps` skips). ML features need libstdc++ from GCC 12+;
on older toolchains (Ubuntu 22.04, RHEL 9) the browser runs normally with ML
disabled. On Ubuntu 24.04+ the installer loads an AppArmor profile (needs
sudo once) so the content sandbox keeps working.

## Notes

- The launcher keeps Astra's profile in `~/.mozilla/astra` (separate from
  Firefox); set `ASTRA_PROFILE` to use another directory.
- `astra-core` (durable storage sidecar) is bundled next to the binary.
- The engine build is not update-enabled; replace the folder to update.
README

echo "== manifest"
GIT_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
cat > "$APP/BUILD.txt" <<BUILD
product: Astra
version: $ASTRA_VERSION
platform: linux-x86_64
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
git: $GIT_BRANCH @ $GIT_COMMIT
engine: Firefox ESR $VERSION (pinned upstream)
work-flag: off (VITE_ASTRA_WORK unset)
package: $NAME
BUILD

echo "== tarball"
tar -cJf "$RELEASE/$NAME.tar.xz" -C "$STAGE" Astra
( cd "$RELEASE" && sha256sum "$NAME.tar.xz" > "$NAME.tar.xz.sha256" )

du -sh "$RELEASE/$NAME.tar.xz"
cat "$RELEASE/$NAME.tar.xz.sha256"
