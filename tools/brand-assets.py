#!/usr/bin/env python3
"""Regenerate every Astra brand raster from the SVG masters.

The masters in `branding/assets/` are the single source of truth; every icon
size, .ico and .icns is derived from `astra-app-icon.svg`. Generated files are
committed so builds never depend on an SVG renderer.

Usage:  python3 tools/brand-assets.py [--check]
        --check  verify the committed outputs are current, write nothing

Renderer: rsvg-convert, then cairosvg, then inkscape (first available).
Stdlib only apart from the optional cairosvg fallback.
"""
from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "branding", "assets")
BRAND = os.path.join(ROOT, "overlay", "astra", "branding")
ABOUT = os.path.join(BRAND, "content")
PUBLIC = os.path.join(ROOT, "ui", "app", "public")

# Icon tiles (opaque paper ground): OS chrome, installers, about:logo, web app.
TILE_SIZES = (16, 32, 48, 64, 128, 256, 512, 1024)
# .ico payloads (Windows) and .icns payloads (macOS).
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_TYPES = (  # (OSType, pixel size) — modern PNG-based entries only.
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
)


def die(msg: str) -> "NoReturn":  # noqa: F821
    sys.exit(f"brand-assets: {msg}")


def renderer() -> str:
    if shutil.which("rsvg-convert"):
        return "rsvg"
    if shutil.which("inkscape"):
        return "inkscape"
    try:
        import cairosvg  # noqa: F401
    except ImportError:
        die("no SVG renderer found (rsvg-convert, inkscape or cairosvg)")
    return "cairosvg"


def render_to(svg: str, out: str, back: str, width: int | None = None,
              height: int | None = None) -> None:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if back == "rsvg":
        cmd = ["rsvg-convert", svg, "-o", out]
        if width:
            cmd += ["-w", str(width)]
        if height:
            cmd += ["-h", str(height)]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    elif back == "inkscape":
        cmd = ["inkscape", svg, f"--export-filename={out}"]
        if width:
            cmd += [f"--export-width={width}"]
        if height:
            cmd += [f"--export-height={height}"]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    else:
        import cairosvg

        cairosvg.svg2png(url=svg, write_to=out, output_width=width,
                         output_height=height)


def render(svg: str, size: int, out: str, back: str) -> None:
    render_to(svg, out, back, width=size, height=size)


def read(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def build_ico(pngs: list[tuple[int, str]]) -> bytes:
    """ICO container with PNG payloads (Vista+)."""
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for size, path in pngs:
        data = read(path)
        # 0 means 256 in the ICO directory.
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32,
                               len(data), offset)
        offset += len(data)
        blobs += data
    return header + entries + blobs


def build_icns(pngs: dict[int, str]) -> bytes:
    """ICNS container with PNG payloads (macOS 10.7+)."""
    body = b""
    for ostype, size in ICNS_TYPES:
        data = read(pngs[size])
        body += ostype + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def pad_svg(src: str, dst: str, frac: float) -> None:
    """Copy an SVG with its viewBox grown by `frac` of its height on every side."""
    text = open(src, encoding="utf-8").read()
    m = re.search(r'viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"', text)
    if not m:
        die(f"{src} has no viewBox")
    x, y, w, h = (float(v) for v in m.groups())
    pad = h * frac
    new = (f'viewBox="{x - pad:.2f} {y - pad:.2f} {w + 2 * pad:.2f} {h + 2 * pad:.2f}"')
    write(dst, text.replace(m.group(0), new).encode())


def copy_plain(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)


def main() -> None:
    check = "--check" in sys.argv
    back = renderer()
    if check:
        die("--check is not implemented; run without flags and review `git status`")

    tmp = os.path.join(ROOT, "target", "brand-assets")
    os.makedirs(tmp, exist_ok=True)

    tile_svg = os.path.join(ASSETS, "astra-app-icon.svg")
    written: list[str] = []

    # 1. raster tiles, one render per size, reused by every consumer
    tiles: dict[int, str] = {}
    for size in TILE_SIZES:
        out = os.path.join(tmp, f"tile-{size}.png")
        render(tile_svg, size, out, back)
        tiles[size] = out
        written.append(out)

    # 2. GTK window/taskbar icons (moz.build: default<size>.png)
    for size in (16, 32, 48, 64, 128):
        copy_plain(tiles[size], os.path.join(BRAND, f"default{size}.png"))

    # 3. 512 icon + SVG master for the branding contract
    copy_plain(tiles[512], os.path.join(BRAND, "astra-icon-512.png"))
    copy_plain(os.path.join(ASSETS, "astra-symbol.svg"),
               os.path.join(BRAND, "astra-logo.svg"))

    # 4. Windows + macOS icon containers
    ico_pngs = []
    for size in ICO_SIZES:
        if size not in tiles:
            out = os.path.join(tmp, f"ico-{size}.png")
            render(tile_svg, size, out, back)
            tiles[size] = out
        ico_pngs.append((size, tiles[size]))
    write(os.path.join(BRAND, "astra.ico"), build_ico(ico_pngs))
    write(os.path.join(BRAND, "astra.icns"), build_icns(tiles))

    # 5. about:logo — the tile reads on any page background
    if 192 not in tiles:
        out = os.path.join(tmp, "about-192.png")
        render(tile_svg, 192, out, back)
        tiles[192] = out
    copy_plain(os.path.join(ASSETS, "astra-app-icon.svg"),
               os.path.join(ABOUT, "about-logo.svg"))
    copy_plain(tiles[192], os.path.join(ABOUT, "about-logo.png"))
    out = os.path.join(tmp, "about-384.png")
    render(tile_svg, 384, out, back)
    copy_plain(out, os.path.join(ABOUT, "about-logo@2x.png"))
    # the about dialog's 300x236 slot: stacked lockup, ink on transparent
    about_art = os.path.join(tmp, "about.png")
    padded = os.path.join(tmp, "about-padded.svg")
    pad_svg(os.path.join(ASSETS, "astra-lockup-stacked.svg"), padded, 0.10)
    render_to(padded, about_art, back, height=236)
    copy_plain(about_art, os.path.join(ABOUT, "about.png"))

    # 6. first-party app art: SVG where the engine can take it, PNG only
    #    where a raster is required (Windows/macOS icon stores).
    copy_plain(os.path.join(ASSETS, "astra-wordmark.svg"),
               os.path.join(PUBLIC, "astra-wordmark.svg"))
    copy_plain(os.path.join(ASSETS, "astra-symbol.svg"),
               os.path.join(PUBLIC, "astra-symbol.svg"))
    copy_plain(os.path.join(ASSETS, "astra-app-icon.svg"),
               os.path.join(PUBLIC, "astra-icon.svg"))
    copy_plain(tiles[128], os.path.join(PUBLIC, "astra-icon.png"))
    copy_plain(tiles[256], os.path.join(PUBLIC, "astra-icon@2x.png"))

    # 7. web icons for any page served from the app bundle
    for size in (16, 32, 48, 180, 192, 512):
        if size not in tiles:
            out = os.path.join(tmp, f"web-{size}.png")
            render(tile_svg, size, out, back)
            tiles[size] = out
    copy_plain(tiles[180], os.path.join(PUBLIC, "apple-touch-icon.png"))
    copy_plain(tiles[192], os.path.join(PUBLIC, "icon-192.png"))
    copy_plain(tiles[512], os.path.join(PUBLIC, "icon-512.png"))
    copy_plain(os.path.join(ASSETS, "astra-app-icon.svg"),
               os.path.join(PUBLIC, "favicon.svg"))
    write(os.path.join(PUBLIC, "favicon.ico"), build_ico(ico_pngs))

    print(f"brand-assets: {back} · {len(written)} renders")
    print("  overlay/astra/branding: default{16,32,48,64,128}.png, astra-icon-512.png,")
    print("                          astra-logo.svg, astra.ico, astra.icns")
    print("  overlay/astra/branding/content: about-logo.{svg,png,@2x.png}")
    print("  ui/app/public: astra-{icon.svg,icon.png,icon@2x.png,wordmark.svg,symbol.svg},")
    print("                 favicon.{svg,ico}, apple-touch-icon.png, icon-{192,512}.png")


if __name__ == "__main__":
    main()
