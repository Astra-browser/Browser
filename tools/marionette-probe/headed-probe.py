"""Headed dev-build probe: launch Astra Firefox visibly, prove the chrome and
app frame really painted, dump UI state and capture the window.

Usage:
  python3 tools/marionette-probe/headed-probe.py [profile-dir] [out-dir]

The default binary is the platform's dev build (`astra_env.BINARY`:
`engine/obj-astra-windows` on Windows, `engine/obj-astra-linux` elsewhere);
`ASTRA_BINARY` overrides it. Windows captures the real top-level window
through Win32 GDI (the compositor target, not the page bitmap); Linux keeps
the existing Hyprland `grim` capture. Pass `--binary` to point at another
build.

The probe fails when the app frame is missing, not booted, has no relay, logs
Astra/Bridge/NS_ERROR console errors, or when the desktop capture is blank.
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
"""
import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import zlib

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST = "127.0.0.1"
PORT = 2828
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IS_WINDOWS = os.name == "nt"
DEFAULT_BINARY = astra_env.BINARY

SNAP_JS = """return JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  const app = q('[data-astra-app]');
  const shell = q('.astra-frame');
  const frame = q('iframe[data-astra-app-frame]');
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height)};
  };
  let conErrs = [];
  try {
    const msgs = Services.console.getMessageArray() || [];
    conErrs = msgs.map(m => {
      try {
        let level = 0;
        try { level = m.errorFlag ? 2 : (m.warningFlag ? 1 : 0); } catch (e) {}
        return {text: String(m.message), level};
      } catch (e) { return {text: '?', level: 0}; }
    }).filter(m => {
      // Real errors only: warnings (layout flush, add-on scans) are noise.
      return m.level >= 2 ||
        /BridgeError|NS_ERROR|uncaught|TypeError|ReferenceError|SyntaxError|script error|crash/i.test(m.text);
    }).map(m => m.text).slice(-20);
  } catch (e) { conErrs = ['con-read-ERR:' + (e && e.message)]; }
  let inner = null;
  try {
    const d = frame && frame.contentDocument;
    const sidebar = d && d.querySelector('aside.browser-sidebar, .browser-sidebar');
    const address = d && d.querySelector('.address-field input');
    const tab = d && d.querySelector('[data-astra-tab-id]');
    const w = frame && frame.contentWindow;
    inner = d ? {
      bridgeMode: d.documentElement?.dataset?.bridgeMode ?? null,
      relayCount: w?.__astraRelayCount ?? null,
      relayError: w?.__astraLastRelayError ?? null,
      sidebar: box(sidebar),
      address: !!address,
      tab: !!tab,
      title: d.title,
      ready: d.readyState,
    } : null;
  } catch (e) { inner = {error: String(e)}; }
  return {
    appReady: app?.dataset?.appReady ?? null,
    relaySeen: app?.dataset?.relaySeen ?? null,
    relayLast: app?.dataset?.relayLast ?? null,
    relayCount: window.__astraRelayCount ?? null,
    relayErrorOuter: window.__astraLastRelayError ?? null,
    booted: shell?.getAttribute('data-app-booted') ?? null,
    frame: box(frame),
    viewport: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    screen: [window.screenX, window.screenY],
    dpr: window.devicePixelRatio || 1,
    windowState: window.windowState,
    appAlert: document.querySelector('.astra-app-mount [role=alert]')?.textContent?.slice(0,300) ?? null,
    slotAlert: document.querySelector('.astra-content [role=alert]')?.textContent?.slice(0,200) ?? null,
    browsers: [...document.querySelectorAll('browser')].map(b => {
      let s = null; try { s = b.currentURI.spec; } catch (e) { s = 'ERR'; }
      return s || '?';
    }),
    title: document.title,
    conErrs,
    inner,
  };
})())"""


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("server closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("server closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]


def wait_port(proc, port, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return None
        try:
            return Marionette(port)
        except Exception:
            time.sleep(0.5)
    return None


# ---------------------------------------------------------------------------
# Linux / Hyprland capture (unchanged behaviour)
# ---------------------------------------------------------------------------

def grim_shot(out_path):
    """Screenshot the live Astra window (class firefox-default, title Astra),
    skipping any crash-reporter dialog."""
    try:
        clients = json.loads(subprocess.run(
            ["hyprctl", "clients", "-j"], capture_output=True,
            timeout=10).stdout or b"[]")
    except Exception as e:
        return f"hyprctl-ERR {e}"
    wins = [c for c in clients
            if c.get("class") == "firefox-default"
            and "crash" not in c.get("title", "").lower()
            and "Astra" in c.get("title", "")]
    if not wins:
        return "no-our-window"
    wins.sort(key=lambda c: c["size"][0] * c["size"][1], reverse=True)
    w = wins[0]
    geom = f"{w['at'][0]},{w['at'][1]} {w['size'][0]}x{w['size'][1]}"
    env = dict(os.environ, WAYLAND_DISPLAY="wayland-1")
    try:
        subprocess.run(["grim", "-g", geom, out_path],
                       capture_output=True, timeout=30, env=env, check=True)
        return f"ok {geom} :: {w.get('title','')[:60]}"
    except Exception as e:
        return f"grim-ERR {e}"


# ---------------------------------------------------------------------------
# Windows desktop capture (Win32 GDI, stdlib ctypes only)
# ---------------------------------------------------------------------------

def _win32():
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    return ctypes, wintypes, user32, gdi32


def _process_image(pid):
    """Return the executable name owning a window, or "" when Windows denies
    the query (then the title hint decides)."""
    ctypes, wintypes, _, _ = _win32()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
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


def _windows_for_pid(pid, title_hint="Astra"):
    """Find the browser's real top-level window.

    The Windows launcher can hand the profile to another `firefox.exe` process,
    so the window is not necessarily owned by the PID we spawned. Prefer a
    window owned by a `firefox.exe` whose title contains the hint, and fall
    back to any visible captioned window for the spawned PID.
    """
    ctypes, wintypes, user32, _ = _win32()
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
        # GWL_STYLE = -16; WS_CAPTION = 0x00C00000 (top-level, not a tooltip).
        style = user32.GetWindowLongPtrW(hwnd, -16)
        title_len = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(title_len + 1)
        user32.GetWindowTextW(hwnd, title, title_len + 1)
        text = title.value
        if "crash" in text.lower():
            return True
        image = _process_image(owner.value)
        found.append({
            "hwnd": hwnd,
            "pid": owner.value,
            "image": image,
            "rect": (rect.left, rect.top, rect.right, rect.bottom),
            "area": area,
            "caption": bool(style & 0x00C00000),
            "title": text,
            "ours": owner.value == pid,
            "browser": image.lower() in ("firefox.exe", "astra.exe"),
            "hinted": bool(title_hint) and title_hint.lower() in text.lower(),
        })
        return True

    user32.EnumWindows(enum_proc, 0)
    found.sort(key=lambda w: (w["browser"] and w["hinted"], w["ours"], w["caption"], w["area"]),
               reverse=True)
    return found


def _capture_hwnd(hwnd):
    """Return (width, height, rgb_rows) from a window via PrintWindow, or the
    screen rectangle when the compositor refuses an off-screen copy."""
    ctypes, wintypes, user32, gdi32 = _win32()

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

    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
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
    # PW_RENDERFULLCONTENT (2) asks the compositor for the full frame.
    pw = getattr(user32, "PrintWindow", None)
    ok = bool(pw(hwnd, hdc_mem, 2)) if pw else False
    if not ok:
        # Screen copy at the window's rectangle (it is foregrounded first).
        hdc_screen = user32.GetDC(0)
        ok = bool(gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, rect.left, rect.top, 0x00CC0020))
        user32.ReleaseDC(0, hdc_screen)
    if not ok:
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(hwnd, hdc_win)
        raise OSError("PrintWindow/BitBlt failed")

    header = BITMAPINFOHEADER()
    header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    header.biWidth = width
    header.biHeight = -height  # top-down
    header.biPlanes = 1
    header.biBitCount = 32
    header.biCompression = 0  # BI_RGB
    info = BITMAPINFO()
    info.bmiHeader = header
    buf = ctypes.create_string_buffer(width * height * 4)
    got = gdi32.GetDIBits(hdc_mem, bmp, 0, height, buf, ctypes.byref(info), 0)
    gdi32.SelectObject(hdc_mem, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_win)
    if got != height:
        raise OSError(f"GetDIBits returned {got}/{height}")

    raw = buf.raw
    rows = []
    for y in range(height):
        start = y * width * 4
        line = raw[start:start + width * 4]
        # BGRA -> RGB, dropping the alpha byte.
        rows.append(bytes(b for i in range(0, len(line), 4) for b in (line[i + 2], line[i + 1], line[i])))
    return width, height, rows


def _write_png(path, width, height, rows):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + row for row in rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 6)))
        f.write(chunk(b"IEND", b""))


def windows_shot(pid, out_path):
    """Capture the browser's real top-level window and report paint evidence."""
    ctypes, wintypes, user32, _ = _win32()
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    wins = _windows_for_pid(pid)
    # Never capture a terminal or another app that merely mentions Astra.
    wins = [x for x in wins if x["browser"] or x["ours"] or x["hinted"]]
    if not wins:
        return {"ok": False, "error": "no-visible-window", "windows": []}
    w = wins[0]
    user32.ShowWindow(w["hwnd"], 9)  # SW_RESTORE
    try:
        user32.SetForegroundWindow(w["hwnd"])
        user32.BringWindowToTop(w["hwnd"])
    except Exception:
        pass
    time.sleep(1.0)
    try:
        width, height, rows = _capture_hwnd(w["hwnd"])
    except Exception as e:
        return {"ok": False, "error": f"capture-{e}", "windows": [x["title"] for x in wins]}
    _write_png(out_path, width, height, rows)

    # Paint evidence: enough distinct colours and local variation to rule out
    # an all-black, all-white or unrendered surface. Sampling every 4th pixel
    # keeps the check cheap for a 4K window.
    colours = set()
    changes = 0
    samples = 0
    for y in range(0, height, 4):
        row = rows[y]
        prev = None
        for x in range(0, width, 4):
            i = x * 3
            px = row[i:i + 3]
            colours.add(px)
            if prev is not None and px != prev:
                changes += 1
            prev = px
            samples += 1
    return {
        "ok": True,
        "path": out_path,
        "width": width,
        "height": height,
        "title": w["title"],
        "colours": len(colours),
        "changed_fraction": round(changes / max(samples, 1), 4),
        "windows": [x["title"] for x in wins],
    }


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    return bool(ok)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", nargs="?", default=None)
    parser.add_argument("outdir", nargs="?", default=None)
    parser.add_argument("--binary", default=os.environ.get("ASTRA_BINARY", DEFAULT_BINARY))
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--keep-open", action="store_true",
                        help="leave the browser open for visual inspection")
    args = parser.parse_args()

    firefox = os.path.abspath(args.binary)
    outdir = args.outdir or os.path.join(ROOT, "out", "headed-windows" if IS_WINDOWS else "headed")
    profile = args.profile or tempfile.mkdtemp(prefix="astra-headed-")
    os.makedirs(outdir, exist_ok=True)
    if args.profile and os.path.isdir(profile):
        shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)

    if not os.path.isfile(firefox):
        print(f"SKIP no binary at {firefox}", file=sys.stderr)
        return 2

    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {args.port});\nuser_pref("astra.onboarding.force", "skip");\n')
        f.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')

    errlog_path = os.path.join(outdir, "stderr.log")
    errlog = open(errlog_path, "wb")
    env = dict(os.environ)
    # Windows: keep the window visible and give it a deterministic size.
    cmd = [firefox, "-profile", os.path.abspath(profile), "-no-remote",
           "-remote-allow-system-access", "--marionette", "about:blank"]
    proc = subprocess.Popen(cmd, cwd=os.path.dirname(firefox),
                            stdout=errlog, stderr=subprocess.STDOUT, env=env)
    print(f"launched pid={proc.pid} binary={firefox}", flush=True)
    failures = []
    m = None
    try:
        m = wait_port(proc, args.port, 90)
        if m is None:
            print("MARIONETTE-NEVER-CAME-UP", flush=True)
            failures.append("marionette")
            return 1
        print("marionette connected", flush=True)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 860})
        time.sleep(2)
        snap = {}
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                snap = json.loads(m.cmd("WebDriver:ExecuteScript", {
                    "script": SNAP_JS, "args": []})["value"])
            except Exception as e:
                snap = {"poll_error": str(e)[:300]}
            if snap.get("booted") == "true" and snap.get("appReady") == "host":
                break
            time.sleep(0.5)
        with open(os.path.join(outdir, "snap.json"), "w", encoding="utf-8") as f:
            json.dump(snap, f, indent=1)
        print("SNAP: " + json.dumps(snap)[:1600], flush=True)

        frame = snap.get("frame") or {}
        inner = snap.get("inner") or {}

        def require(name, ok, detail=""):
            if not check(name, ok, detail):
                failures.append(name)

        require("app frame booted in host mode",
                snap.get("booted") == "true" and snap.get("appReady") == "host",
                f"booted={snap.get('booted')} appReady={snap.get('appReady')}")
        require("shell relay reached the app",
                snap.get("relaySeen") == "true"
                or (inner.get("bridgeMode") == "relay"
                    and int(snap.get("relayCount") or 0) > 0
                    and not snap.get("relayErrorOuter")),
                f"relaySeen={snap.get('relaySeen')} mode={inner.get('bridgeMode')} "
                f"count={snap.get('relayCount')} err={snap.get('relayErrorOuter')} "
                f"last={snap.get('relayLast')}")
        require("app frame is laid out",
                bool(frame) and frame.get("w", 0) > 600 and frame.get("h", 0) > 500,
                str(frame))
        require("sidebar is painted in the frame",
                bool(inner.get("sidebar")) and inner["sidebar"].get("w", 0) > 100,
                str(inner.get("sidebar")))
        require("address field and a tab row exist",
                inner.get("address") is True and inner.get("tab") is True,
                f"address={inner.get('address')} tab={inner.get('tab')}")
        errors = snap.get("conErrs") or []
        require("no Astra/Bridge/NS_ERROR console errors", not errors, str(errors[-3:]))
        require("no app-level error alert", not snap.get("appAlert"), str(snap.get("appAlert")))

        shot = {}
        if IS_WINDOWS:
            shot = windows_shot(proc.pid, os.path.join(outdir, "window.png"))
            with open(os.path.join(outdir, "shot-meta.json"), "w", encoding="utf-8") as f:
                json.dump(shot, f, indent=1)
            if not shot.get("ok"):
                failures.append("window-capture")
                print(f"FAIL window capture :: {shot}", flush=True)
            else:
                require("captured window is desktop-sized",
                        shot["width"] >= 900 and shot["height"] >= 600,
                        f"{shot['width']}x{shot['height']}")
                require("captured window is not blank",
                        shot["colours"] > 200 and shot["changed_fraction"] > 0.02,
                        f"colours={shot['colours']} changed={shot['changed_fraction']}")
                # The desktop capture is at physical pixels; the chrome viewport
                # is CSS pixels. Allow the frame/titlebar and 100/125/150% DPI.
                vw, vh = snap.get("viewport") or [0, 0]
                ratio = shot["width"] / max(vw * (snap.get("dpr") or 1), 1)
                require("capture matches the live viewport / DPI",
                        0.7 <= ratio <= 1.3,
                        f"capture={shot['width']}x{shot['height']} viewport={vw}x{vh} dpr={snap.get('dpr')}")
            print("WINDOW: " + json.dumps({k: v for k, v in shot.items() if k != "windows"}), flush=True)
        else:
            print("GRIM: " + grim_shot(os.path.join(outdir, "grim.png")), flush=True)
        try:
            png = m.cmd("WebDriver:TakeScreenshot", {})["value"]
            with open(os.path.join(outdir, "shot.png"), "wb") as f:
                f.write(base64.b64decode(png))
            print("screenshot ok", flush=True)
        except Exception as e:
            print(f"screenshot-ERR {e}", flush=True)

        print(f"wrote {outdir}", flush=True)
        print(f"{'PASS' if not failures else 'FAIL'} ({len(failures)} failed)"
              + (f": {failures}" if failures else ""), flush=True)
        return 0 if not failures else 1
    finally:
        if m is not None and not args.keep_open:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        if not args.keep_open:
            try:
                proc.wait(timeout=15)
            except Exception:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except Exception:
                    proc.kill()
        else:
            print("LEAVING BROWSER OPEN for visual inspection", flush=True)
        errlog.close()


if __name__ == "__main__":
    sys.exit(main())
