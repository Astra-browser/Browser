"""Live frame probe: titlebar, window controls, drag region and first paint.

Usage:
  python tools/windows/frame-probe.py [path-to-astra.exe]

Launches the build visibly with a throwaway profile, waits for the app frame,
then reports the chrome geometry that decides whether the window can be
dragged and whether minimise/maximise/close are reachable. Captures the real
window through the same Win32 path as headed-probe.py.

Exit 0 PASS, 1 FAIL, 2 SKIP (no binary).
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HOST = "127.0.0.1"
PORT = 2852
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT = os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "Programs", "Astra", "astra.exe"
)
FIREFOX = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
OUT = os.path.join(ROOT, "out", "frame-probe")
DRAG = "--drag" in sys.argv


class M:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("marionette did not open")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c:
                raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c:
                raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    return bool(ok)


def marionette_drag(m, dx=180, dy=120):
    """Drag the shell's top gutter with trusted WebDriver pointer input."""
    before = json.loads(m.js("return JSON.stringify([window.screenX, window.screenY]);"))
    w = int(m.js("return window.innerWidth;"))
    m.cmd("WebDriver:PerformActions", {"actions": [{
        "type": "pointer", "id": "mouse",
        "parameters": {"pointerType": "mouse"},
        "actions": [
            {"type": "pointerMove", "x": max(80, w // 2), "y": 4},
            {"type": "pointerDown", "button": 0},
            {"type": "pointerMove", "x": max(80, w // 2) + dx, "y": 4 + dy, "duration": 250},
            {"type": "pointerUp", "button": 0},
        ],
    }]})
    time.sleep(0.8)
    after = json.loads(m.js("return JSON.stringify([window.screenX, window.screenY]);"))
    m.cmd("WebDriver:ReleaseActions", {})
    return before, after, (after[0] - before[0], after[1] - before[1])


def drag_top_edge(hwnd, dx=180, dy=120):
    """Drag from the window's top gutter and report the rect before/after."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    before = (rect.left, rect.top, rect.right, rect.bottom)
    x = rect.left + max(100, (rect.right - rect.left) // 2)
    y = rect.top + 7
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.2)
    user32.SetCursorPos(x, y)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.1)
    for step in range(1, 11):
        user32.SetCursorPos(x + dx * step // 10, y + dy * step // 10)
        time.sleep(0.02)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.5)
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    after = (rect.left, rect.top, rect.right, rect.bottom)
    return before, after, (after[0] - before[0], after[1] - before[1])


def main():
    if not os.path.isfile(FIREFOX):
        print(f"SKIP no binary at {FIREFOX}", file=sys.stderr)
        return 2
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-frame-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    failed = 0
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1000, "height": 700})
        deadline = time.time() + 90
        booted = None
        while time.time() < deadline:
            booted = m.js(
                "return document.querySelector('.astra-frame')"
                "?.getAttribute('data-app-booted');")
            if booted == "true":
                break
            time.sleep(0.3)
        time.sleep(2)
        info = json.loads(m.js("""
          const q = (s) => document.querySelector(s);
          const box = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const s = el.ownerDocument?.defaultView?.getComputedStyle(el);
            return {x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width),
                    h:Math.round(r.height), display:s?.display, opacity:s?.opacity,
                    visibility:s?.visibility, pe:s?.pointerEvents,
                    drag:s?.getPropertyValue('-moz-window-dragging')};
          };
          const bar = q('.astra-titlebar');
          const edges = [...document.querySelectorAll('box[style*="window-dragging"]')].map(box);
          const controls = q('.astra-window-controls');
          const buttons = controls ? [...controls.querySelectorAll('button')].map((b) => ({
            action:b.dataset.action, text:b.textContent, box:box(b),
          })) : [];
          const frame = q('.astra-frame');
          const content = q('.astra-content');
          const app = q('iframe[data-astra-app-frame]');
          const appDoc = app && app.contentDocument;
          const appControls = appDoc?.querySelector('.window-controls');
          const appButtons = appControls ? [...appControls.querySelectorAll('button')].map((b) => ({
            action: b.getAttribute('aria-label'), box: box(b),
          })) : [];
          const dragRegions = appDoc ? [...appDoc.querySelectorAll('[data-drag-region]')].map((el) => ({
            cls: el.className, box: box(el),
          })) : [];
          let drawInTitlebar = null;
          try { drawInTitlebar = Services.prefs.getBoolPref('browser.tabs.drawInTitlebar'); } catch (e) {}
          return JSON.stringify({
            booted: frame?.getAttribute('data-app-booted') ?? null,
            viewport: [window.innerWidth, window.innerHeight],
            outer: [window.outerWidth, window.outerHeight],
            screen: [window.screenX, window.screenY],
            windowState: window.windowState,
            drawInTitlebar,
            rootCustomTitlebar: document.documentElement.getAttribute('customtitlebar'),
            rootSizemode: document.documentElement.getAttribute('sizemode'),
            titlebar: box(bar),
            edges,
            controls: box(controls),
            buttons,
            frame: box(frame),
            content: box(content),
            app: box(app),
            appControls: box(appControls),
            appButtons,
            dragRegions,
            appTitle: appDoc?.title ?? null,
            title: document.title,
            fullscreen: frame?.getAttribute('data-astra-fullscreen') ?? null,
          });
        """))
        print(json.dumps(info, indent=1))

        def req(name, ok, detail=""):
            nonlocal failed
            if not check(name, ok, detail):
                failed += 1

        req("the app frame is booted", info.get("booted") == "true", info.get("booted"))
        ctl = info.get("appControls") or {}
        req("window controls are laid out", bool(ctl) and ctl.get("w", 0) >= 90, ctl)
        req("window controls are visible at rest",
            ctl.get("display") != "none" and ctl.get("visibility") != "hidden"
            and ctl.get("opacity") not in ("0", 0), ctl)
        labels = {b.get("action") for b in info.get("appButtons", [])}
        req("minimise, maximise and close exist", len(labels) == 3, sorted(labels))
        drag = info.get("edges", [])
        req("four window drag edges are rendered", len(drag) == 4,
            [(r.get("w"), r.get("h")) for r in drag])
        vw, vh = info.get("viewport") or [0, 0]
        req("window controls sit in the top-right corner",
            ctl.get("x", -1) >= vw - 160 and ctl.get("y", -1) <= 16, ctl)
        req("the drag region is inside the viewport",
            all(r.get("y", -1) >= 0 and r.get("w", 0) > 0 for r in drag), drag)

        if DRAG:
            try:
                before, after, moved = marionette_drag(m)
                req("the window moves when the top gutter is dragged",
                    abs(moved[0]) >= 20 or abs(moved[1]) >= 20,
                    f"{before} -> {after} moved={moved}")
            except Exception as e:
                req("the window moves when the top gutter is dragged", False, str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        failed += 1
    finally:
        if m is not None:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        try:
            proc.wait(timeout=20)
        except Exception:
            proc.kill()
        log.close()
    print(f"\n{'PASS' if failed == 0 else 'FAIL'} ({failed} failed)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
