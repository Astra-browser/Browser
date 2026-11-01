#!/usr/bin/env python3
"""P3-T11 golden compare: standalone-baseline (Chromium) vs in-Firefox
captures, per tools/golden-capture/MASKS.md.

Pixel policy (§9.2, MANIFEST.md "Rerun variance"):
  - Gate: ≤ 1.5% differing pixels per screen.
  - Text/antialiasing allowance: a pixel counts as different only if some
    channel differs by more than TOL (default 16). This absorbs subpixel /
    hinting drift between engines while keeping the 1.5% gate meaningful for
    non-text regions (chrome geometry, cards, charts — all exact at none
    material).
  - Stdlib only (zlib PNG decode — no PIL/numpy, so CI needs nothing).

Reads tests/golden/baseline/*.png vs tests/golden/in-firefox/*.png
(same stems). Screens listed in in-firefox/captures.json "skipped" (with a
recorded reason, e.g. the headless 500px window floor) report SKIP — listed,
never silently dropped. Writes results.json + prints a markdown table.
Exit 0 when every screen is PASS or SKIP, else 1.
"""
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BASELINE = os.path.join(ROOT, "tests", "golden", "baseline")
INFF = os.path.join(ROOT, "tests", "golden", "in-firefox")
GATE_PCT = float(os.environ.get("GOLDEN_GATE_PCT", "1.5"))
TOL = int(os.environ.get("GOLDEN_TOL", "16"))


def read_png(path):
    with open(path, "rb") as f:
        sig = f.read(8)
    assert sig == b"\x89PNG\r\n\x1a\n", f"not a PNG: {path}"
    with open(path, "rb") as f:
        data = f.read()
    pos, w, h, bitd, ctype, comp, filt, inter = 8, None, None, 0, 0, 0, 0, 0
    raw = b""
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bitd, ctype, comp, filt, inter = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"IDAT":
            raw += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    assert bitd == 8 and not inter, f"unsupported PNG (bitdepth={bitd} interlace={inter}): {path}"
    assert ctype in (2, 6), f"unsupported color type {ctype}: {path}"
    ch = 3 if ctype == 2 else 4
    stride = w * ch
    out = bytearray(w * h * ch)
    prev = bytearray(stride)
    px = zlib.decompress(raw)
    p = 0
    for y in range(h):
        f = px[p]
        p += 1
        line = bytearray(px[p:p + stride])
        p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif f != 0:
            raise ValueError(f"bad filter {f}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, bytes(out)


def to_rgb(w, h, ch, px):
    if ch == 3:
        return px
    out = bytearray(w * h * 3)
    for i in range(w * h):
        r, g, b, a = px[4 * i:4 * i + 4]
        if a == 255:
            out[3 * i:3 * i + 3] = bytes((r, g, b))
        else:
            # Blend onto white (screenshots are opaque in practice).
            out[3 * i] = (r * a + 255 * (255 - a)) // 255
            out[3 * i + 1] = (g * a + 255 * (255 - a)) // 255
            out[3 * i + 2] = (b * a + 255 * (255 - a)) // 255
    return bytes(out)


def half_res(w, h, rgb):
    """2x2 box-average downscale: kills 1px antialiasing drift while keeping
    layout/color differences. A screen whose full-res diff is over gate but
    whose half-res diff is far under gate differs only at raster level."""
    w2, h2 = w // 2, h // 2
    out = bytearray(w2 * h2 * 3)
    for y in range(h2):
        for x in range(w2):
            o = 3 * (y * w2 + x)
            for c in range(3):
                s = (rgb[3 * ((2 * y) * w + 2 * x) + c] +
                     rgb[3 * ((2 * y) * w + 2 * x + 1) + c] +
                     rgb[3 * ((2 * y + 1) * w + 2 * x) + c] +
                     rgb[3 * ((2 * y + 1) * w + 2 * x + 1) + c])
                out[o + c] = (s + 2) // 4
    return w2, h2, bytes(out)


def compare(a_rgb, b_rgb, n):
    diff_tol = diff_strict = 0
    maxd = 0
    for i in range(n * 3):
        d = abs(a_rgb[i] - b_rgb[i])
        if d > maxd:
            maxd = d
    for i in range(n):
        o = 3 * i
        ds = (abs(a_rgb[o] - b_rgb[o]), abs(a_rgb[o + 1] - b_rgb[o + 1]),
              abs(a_rgb[o + 2] - b_rgb[o + 2]))
        if max(ds) > 0:
            diff_strict += 1
        if max(ds) > TOL:
            diff_tol += 1
    return diff_tol, diff_strict, maxd


def main():
    names = sorted(f[:-4] for f in os.listdir(BASELINE) if f.endswith(".png"))
    if not names:
        print("FAIL: no baseline PNGs", flush=True)
        return 1
    try:
        with open(os.path.join(INFF, "captures.json")) as f:
            skips = {s["name"]: s.get("reason", "") for s in
                     json.load(f).get("skipped", [])}
    except (OSError, ValueError):
        skips = {}
    rows = []
    worst = 0.0
    for name in names:
        bpath = os.path.join(BASELINE, name + ".png")
        ipath = os.path.join(INFF, name + ".png")
        if not os.path.isfile(ipath):
            if name in skips:
                rows.append({"name": name, "status": "SKIP",
                             "reason": skips[name]})
            else:
                rows.append({"name": name, "status": "MISSING"})
            continue
        bw, bh, bch, bpx = read_png(bpath)
        iw, ih, ich, ipx = read_png(ipath)
        if (bw, bh) != (iw, ih):
            rows.append({"name": name, "status": "DIM-MISMATCH",
                         "baseline": [bw, bh], "in_firefox": [iw, ih]})
            continue
        n = bw * bh
        a_rgb = to_rgb(bw, bh, bch, bpx)
        b_rgb = to_rgb(iw, ih, ich, ipx)
        dt, ds, maxd = compare(a_rgb, b_rgb, n)
        pct = 100.0 * dt / n
        spct = 100.0 * ds / n
        worst = max(worst, pct)
        _, _, ha = half_res(bw, bh, a_rgb)
        _, _, hb = half_res(iw, ih, b_rgb)
        hn = (bw // 2) * (bh // 2)
        hdt, _, _ = compare(ha, hb, hn)
        hpct = 100.0 * hdt / hn
        rows.append({"name": name, "status": "PASS" if pct <= GATE_PCT else "FAIL",
                     "diff_pct": round(pct, 3), "strict_pct": round(spct, 3),
                     "half_pct": round(hpct, 3),
                     "max_channel_delta": maxd, "pixels": n})
    fails = [r for r in rows
             if r["status"] not in ("PASS", "SKIP")]
    os.makedirs(INFF, exist_ok=True)
    with open(os.path.join(INFF, "compare.json"), "w") as f:
        json.dump({"gate_pct": GATE_PCT, "tolerance": TOL,
                   "screens": rows}, f, indent=1)
    print(f"| screen | status | diff% (tol {TOL}) | half% | strict% | max Δ |")
    print("| --- | --- | --- | --- | --- | --- |")
    for r in rows:
        if r["status"] == "PASS":
            print(f"| {r['name']} | PASS | {r['diff_pct']} | {r['half_pct']} | {r['strict_pct']} | {r['max_channel_delta']} |")
        elif r["status"] == "SKIP":
            print(f"| {r['name']} | SKIP | — | — | — | {r.get('reason', '')} |")
        elif r["status"] in ("MISSING", "DIM-MISMATCH"):
            extra = r.get("in_firefox", "absent")
            print(f"| {r['name']} | {r['status']} | — | — | — | {extra} |")
        else:
            print(f"| {r['name']} | FAIL | {r['diff_pct']} | {r['half_pct']} | {r['strict_pct']} | {r['max_channel_delta']} |")
    print(f"[compare] gate ≤ {GATE_PCT}%: "
          f"{len(rows) - len(fails)}/{len(rows)} pass-or-skip, worst {worst:.3f}%", flush=True)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
