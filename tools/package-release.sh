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
python3 - "$ROOT" <<'PY'
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
( cd "$ROOT/engine" && MOZCONFIG="$MOZCONFIG" SCCACHE_DIR="$ROOT/out/sccache" ./mach package )

SRC_TARBALL="$(ls -1 "$DIST"/firefox-*.en-US.linux-x86_64.tar.xz | head -1)"
VERSION="$(basename "$SRC_TARBALL" | sed -E 's/^firefox-([0-9.]+)\..*/\1/')"
NAME="Astra-$VERSION-linux-x86_64"
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
cp "$BRAND/PLACEHOLDER-icon-512.png" "$APP/package/icons/astra-512.png"

cat > "$APP/package/astra" <<'WRAPPER'
#!/bin/sh
SELF=$(readlink -f "$0")
PROFILE="${ASTRA_PROFILE:-$HOME/.mozilla/astra}"
for arg in "$@"; do
  [ "$arg" = "-profile" ] && exec "$(dirname "$SELF")/../firefox" "$@"
done
mkdir -p "$PROFILE"
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
StartupWMClass=firefox-default
Categories=Network;WebBrowser;
Keywords=web;browser;internet;
DESKTOP

echo "== install script"
cat > "$APP/install.sh" <<'INSTALL'
#!/usr/bin/env bash
# Install Astra for the current user.
#
#   ./install.sh                     -> ~/.local/opt/astra + ~/.local/bin/astra
#   sudo ./install.sh --system       -> /usr/local/opt/astra
#
# The browser folder is copied, so the downloaded/extracted folder can be
# deleted afterwards. Run uninstall.sh from the install directory to remove it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="$HOME/.local/opt/astra"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share"
SYSTEM=0

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
    --help|-h) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

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

GTK 3, dbus-glib, ALSA/PulseAudio and an X11 or Wayland session — the same
runtime libraries a Firefox ESR 153 build needs. No Node, Rust or compiler is
needed to run this build.

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
version: $VERSION
platform: linux-x86_64
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
git: $GIT_BRANCH @ $GIT_COMMIT
engine: Firefox ESR 153.6.0 (pinned upstream)
work-flag: off (VITE_ASTRA_WORK unset)
package: $NAME
BUILD

echo "== tarball"
tar -cJf "$RELEASE/$NAME.tar.xz" -C "$STAGE" Astra
( cd "$RELEASE" && sha256sum "$NAME.tar.xz" > "$NAME.tar.xz.sha256" )

du -sh "$RELEASE/$NAME.tar.xz"
cat "$RELEASE/$NAME.tar.xz.sha256"
