#!/usr/bin/env bash
# Alpha distro packages for Astra (0.1.745, channel: alpha).
#
# Builds installable system packages for the four supported Linux distro
# families from ONE engine build (out/release/stage/Astra). Same bits in
# every package; only metadata (deps, scripts) differs per family:
#
#   release/astra_0.1.745~alpha1_amd64.deb              Debian / Ubuntu / Mint / Pop!_OS
#   release/astra-0.1.745-0.1.alpha1-fedora.x86_64.rpm   Fedora / RHEL / Rocky / Alma
#   release/astra-0.1.745-0.1.alpha1-opensuse.x86_64.rpm openSUSE Leap / Tumbleweed
#   release/astra-0.1.745.alpha1-1-x86_64.pkg.tar.zst    Arch / CachyOS / Manjaro
#
# Usage:
#   ./tools/package-alpha.sh                 # this OS only (from /etc/os-release)
#   ./tools/package-alpha.sh --distro debian # one family: debian|fedora|suse|arch
#   ./tools/package-alpha.sh --all           # all four into release/
#
# The payload is prebuilt, so any host can cross-build any family; OS detection
# only selects the default yaml. release/ is git-ignored (large binaries).
#
# Requirements: nfpm >= 2.48 in PATH (https://nfpm.goreleaser.com/install/),
# a staged build from tools/package-release.sh, x86_64 host.
#
# Layout inside every package (FHS, mirrors install.sh --system paths):
#   /usr/lib/astra/            browser tree + astra-core sidecar
#   /usr/bin/astra -> /usr/lib/astra/package/astra
#   /usr/share/applications/astra.desktop
#   /usr/share/icons/hicolor/*/apps/astra.png
#   /etc/apparmor.d/astra     Ubuntu 24.04+ userns profile (inert elsewhere,
#                             loaded best-effort by postinstall)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/out/release/stage/Astra"
PAYLOAD="$ROOT/out/distro-payload"
RELEASE="$ROOT/release"
CONF="$ROOT/tools/distro-packages"

die() { echo "package-alpha.sh: $*" >&2; exit 1; }

# --- distro selection (same families as setup.sh) ------------------------------
# Parsed before any work so --help and bad flags exit fast.
DETECTED="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *"debian"*|*"ubuntu"*|*"mint"*|*"pop"*) DETECTED="debian" ;;
    *"fedora"*|*"rhel"*|*"centos"*|*"rocky"*|*"alma"*) DETECTED="fedora" ;;
    *"suse"*|*"opensuse"*) DETECTED="suse" ;;
    *"arch"*) DETECTED="arch" ;;
  esac
fi

WANT="os"
while [ $# -gt 0 ]; do
  case "$1" in
    --all) WANT="all"; shift ;;
    --distro=*) WANT="${1#--distro=}"; shift ;;
    --distro) [ $# -ge 2 ] || die "--distro needs a value"; WANT="$2"; shift 2 ;;
    -h|--help) sed -n '13,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
case "$WANT" in
  os)
    [ "$DETECTED" != "unknown" ] || die "unsupported distro (no /etc/os-release match); use --distro <debian|fedora|suse|arch> or --all"
    WANT="$DETECTED" ;;
  opensuse|suse) WANT="suse" ;;
  debian|fedora|arch|all) ;;
  *) die "--distro must be one of: debian, fedora, suse, arch" ;;
esac

ASTRA_VERSION="$(sed -nE 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"?([^"#]+)"?[[:space:]]*$/\1/p' "$ROOT/branding/astra.toml" | head -n1 | tr -d '[:space:]')"
[ -n "$ASTRA_VERSION" ] || die "branding/astra.toml has no version"

[ -x "$STAGE/firefox" ] || die "no staged build at $STAGE — run tools/package-release.sh first"
STAGE_VERSION="$(sed -nE 's/^version: //p' "$STAGE/BUILD.txt" | head -n1 | tr -d '[:space:]')"
[ "$STAGE_VERSION" = "$ASTRA_VERSION" ] || die "staged build is $STAGE_VERSION but branding says $ASTRA_VERSION — rebuild first"

command -v nfpm >/dev/null 2>&1 || die "nfpm not in PATH (https://nfpm.goreleaser.com/install/ — this release used v2.48.0)"
[ "$(uname -m)" = "x86_64" ] || die "x86_64-only (running on $(uname -m))"

echo "== payload from $STAGE (Astra $ASTRA_VERSION)"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/usr/lib/astra" "$PAYLOAD/usr/share/applications" "$PAYLOAD/etc/apparmor.d"
cp -a "$STAGE/." "$PAYLOAD/usr/lib/astra/"
# The portable installer + tarball README make no sense in a system package.
rm -f "$PAYLOAD/usr/lib/astra/install.sh" "$PAYLOAD/usr/lib/astra/README.md"
# install.sh --system paths: desktop entry, icons, AppArmor profile.
sed 's|@EXEC@|/usr/bin/astra|' "$STAGE/package/astra.desktop.in" > "$PAYLOAD/usr/share/applications/astra.desktop"
chmod 644 "$PAYLOAD/usr/share/applications/astra.desktop"
for size in 16 32 48 64 128 512; do
  dir="$PAYLOAD/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  cp "$STAGE/package/icons/astra-${size}.png" "$dir/astra.png"
done
sed 's|@PREFIX@|/usr/lib/astra|' "$STAGE/package/apparmor/astra.in" > "$PAYLOAD/etc/apparmor.d/astra"
chmod 644 "$PAYLOAD/etc/apparmor.d/astra"
# Symlink, kept literal inside the tree so every packager preserves it.
mkdir -p "$PAYLOAD/usr/bin"
ln -sfn /usr/lib/astra/package/astra "$PAYLOAD/usr/bin/astra"

mkdir -p "$RELEASE"

build() { # <packager> <config> <outfile>
  echo "== $1 -> $3"
  ( cd "$ROOT" && nfpm package --packager "$1" --config "$2" --target "$RELEASE/$3" )
}

BUILT=""
build_one() { # <family>
  local out=""
  case "$1" in
    debian) out="astra_${ASTRA_VERSION}~alpha1_amd64.deb"; build deb "$CONF/nfpm-debian.yaml" "$out" ;;
    fedora) out="astra-${ASTRA_VERSION}-0.1.alpha1-fedora.x86_64.rpm"; build rpm "$CONF/nfpm-fedora.yaml" "$out" ;;
    suse)   out="astra-${ASTRA_VERSION}-0.1.alpha1-opensuse.x86_64.rpm"; build rpm "$CONF/nfpm-opensuse.yaml" "$out" ;;
    arch)   out="astra-${ASTRA_VERSION}.alpha1-1-x86_64.pkg.tar.zst"; build archlinux "$CONF/nfpm-arch.yaml" "$out" ;;
  esac
  BUILT="$BUILT $out"
}

if [ "$WANT" = "all" ]; then
  echo "== building all four distro families"
  for fam in debian fedora suse arch; do build_one "$fam"; done
else
  echo "== family: $WANT"
  build_one "$WANT"
fi

echo "== checksums (merged into SHA256SUMS)"
( cd "$RELEASE" && touch SHA256SUMS
  # shellcheck disable=SC2086
  for f in $BUILT; do
    grep -vF "  $f" SHA256SUMS > SHA256SUMS.tmp || true
    sha256sum "$f" >> SHA256SUMS.tmp
    sort -o SHA256SUMS SHA256SUMS.tmp
  done
  rm -f SHA256SUMS.tmp )
cat "$RELEASE/SHA256SUMS"
# shellcheck disable=SC2086
( cd "$RELEASE" && du -sh $BUILT )
