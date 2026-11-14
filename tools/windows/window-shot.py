"""Capture only the running Astra browser window.

Usage:
  python tools/windows/window-shot.py --list
  python tools/windows/window-shot.py --out out/window.png
  python tools/windows/window-shot.py --count 5 --interval 0.5 --out-dir out/frames
  python tools/windows/window-shot.py --pid 1234 --json

This is deliberately window-only: it finds the Astra top-level window and
copies that client frame through Win32 `PrintWindow`. It never captures the
desktop, so a video or another app beside the browser is not included, and it
does not raise or focus the window. If the window is occluded, `PrintWindow`
still asks the compositor for its own frame; a failure is reported instead of
falling back to a full-screen grab.

Playwright can read the page DOM/screenshot, but it cannot see the native
window chrome (titlebar, caption buttons) or the desktop frame. This helper is
the chrome-side capture; use a Marionette probe for DOM state.

Exit 0 on success, 1 on failure, 2 when no matching window is present.
"""
import argparse
import ctypes
import json
import os
import struct
import sys
import time
import zlib
from ctypes import wintypes

DEFAULT_PROCESSES = ("astra.exe", "firefox.exe")
DEFAULT_TITLE = "Astra"

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def process_image(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return os.path.basename(buf.value)
    finally:
        kernel32.CloseHandle(handle)


def list_windows(processes=DEFAULT_PROCESSES, title_hint=DEFAULT_TITLE, pid=None):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        area = (rect.right - rect.left) * (rect.bottom - rect.top)
        if area < 100 * 100:
            return True
        user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        style = user32.GetWindowLongPtrW(hwnd, -16)
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        image = process_image(owner.value)
        if pid is not None and owner.value != pid:
            return True
        if image.lower() not in {p.lower() for p in processes}:
            return True
        if title_hint and title_hint.lower() not in title.value.lower():
            return True
        found.append({
            "hwnd": hwnd,
            "pid": owner.value,
            "image": image,
            "title": title.value,
            "rect": [rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top],
            "area": area,
            "caption": bool(style & 0x00C00000),
        })
        return True

    user32.EnumWindows(enum_proc, 0)
    found.sort(key=lambda w: (w["caption"], w["area"]), reverse=True)
    return found


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def capture(hwnd):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise OSError("GetWindowRect failed")
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise OSError("window has no area")

    hdc_win = user32.GetWindowDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    bmp = gdi32.CreateCompatibleBitmap(hdc_win, width, height)
    old = gdi32.SelectObject(hdc_mem, bmp)
    try:
        if not user32.PrintWindow(hwnd, hdc_mem, 2):
            raise OSError("PrintWindow failed (window may be minimized)")
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0
        buf = ctypes.create_string_buffer(width * height * 4)
        if gdi32.GetDIBits(hdc_mem, bmp, 0, height, buf, ctypes.byref(info), 0) != height:
            raise OSError("GetDIBits failed")
    finally:
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(hwnd, hdc_win)

    raw = buf.raw
    rows = []
    for y in range(height):
        start = y * width * 4
        line = raw[start:start + width * 4]
        rows.append(bytes(b for i in range(0, len(line), 4)
                          for b in (line[i + 2], line[i + 1], line[i])))
    return width, height, rows


def write_png(path, width, height, rows):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + row for row in rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 6)))
        f.write(chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list matching windows")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--process", default=",".join(DEFAULT_PROCESSES),
                        help="comma-separated executable names")
    parser.add_argument("--title", default=DEFAULT_TITLE,
                        help="substring the window title must contain")
    parser.add_argument("--out", default=None, help="PNG path for one frame")
    parser.add_argument("--out-dir", default=None, help="directory for --count frames")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--json", action="store_true", help="print capture metadata")
    args = parser.parse_args()

    processes = tuple(p.strip() for p in args.process.split(",") if p.strip())
    windows = list_windows(processes, args.title, args.pid)
    if args.list:
        print(json.dumps(windows, indent=1))
        return 0 if windows else 2
    if not windows:
        print(f"no {args.title!r} window from {processes}", file=sys.stderr)
        return 2

    win = windows[0]
    out = args.out or os.path.join("out", "window-shot.png")
    if args.count > 1:
        out_dir = args.out_dir or os.path.join("out", "window-frames")
        os.makedirs(out_dir, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    results = []
    for index in range(max(1, args.count)):
        path = out
        if args.count > 1:
            path = os.path.join(out_dir, f"frame-{index:03d}.png")
        try:
            width, height, rows = capture(win["hwnd"])
        except Exception as e:
            print(f"capture failed: {e}", file=sys.stderr)
            return 1
        write_png(path, width, height, rows)
        results.append({
            "path": os.path.abspath(path),
            "width": width,
            "height": height,
            "pid": win["pid"],
            "title": win["title"],
            "time": time.time(),
        })
        if args.count > 1 and index + 1 < args.count:
            time.sleep(max(0.0, args.interval))

    if args.json:
        print(json.dumps(results, indent=1))
    else:
        for item in results:
            print(f"{item['path']} {item['width']}x{item['height']} pid={item['pid']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
