"""Correlate painted frames with the app DOM at the same instant.

Launches one Astra window, and for each captured frame records what the app
document actually contains (root opacity, Space bar rect, tab row rect,
account foot rect, reveal timestamp). Matches the window by PID.
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time

PORT = 2839
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = "out/headed-frames2"

profile = tempfile.mkdtemp(prefix="astra-fc2-")
with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
    f.write(f'user_pref("marionette.port", {PORT});\n')
log = open(os.path.join(profile, "log"), "wb")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)

proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT)


class M:
    def __init__(self, port):
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
                break
            except OSError:
                time.sleep(0.05)
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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:200]}")
                return msg[3]


PROBE = """return (() => {
  const f = document.querySelector('iframe.astra-app-frame');
  const d = f && f.contentDocument;
  if (!d) return JSON.stringify({noDoc:true});
  const root = d.getElementById('root');
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)]; };
  const bar = d.querySelector('.space-bar');
  const row = d.querySelector('[data-astra-tab-id]');
  const foot = d.querySelector('.shelf .case');
  return JSON.stringify({
    docT: Math.round(d.defaultView.performance.now()),
    reveal: d.documentElement?.dataset?.astraReveal ?? null,
    frameOpacity: f ? (f.style.opacity || 'unset') : null,
    opacity: root ? (root.style.opacity || 'unset') : 'no-root',
    space: rect(bar), spaceText: bar ? (bar.textContent||'').trim().slice(0,8) : null,
    row: rect(row), foot: rect(foot),
  });
})()"""


def our_window():
    try:
        cs = json.loads(
            subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, timeout=5).stdout or b"[]"
        )
    except Exception:
        return None
    for c in cs:
        if c.get("pid") == proc.pid and c.get("class") == "firefox-default":
            return c
    return None


m = M(PORT)
m.cmd("WebDriver:NewSession", {"capabilities": {}})
m.cmd("Marionette:SetContext", {"value": "chrome"})

t0 = time.time()
shot = 0
while time.time() - t0 < 12:
    w = our_window()
    if w:
        geom = f"{w['at'][0]},{w['at'][1]} {w['size'][0]}x{w['size'][1]}"
        env = dict(os.environ, WAYLAND_DISPLAY="wayland-1")
        subprocess.run(["grim", "-g", geom, f"{OUT}/f{shot:02d}.png"], check=False, env=env, timeout=20)
        try:
            dom = m.cmd("WebDriver:ExecuteScript", {"script": PROBE, "args": []})["value"]
        except Exception as error:
            dom = json.dumps({"err": str(error)[:60]})
        print(f"{(time.time()-t0):5.2f}s f{shot:02d} {dom}", flush=True)
        shot += 1
        if shot >= 10:
            break
    time.sleep(0.1)

print("pid", proc.pid, "leaving open", flush=True)
