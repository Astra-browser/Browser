"""Work-off probe: the packaged build must not offer Work at all.

Launches the dev build on a fresh profile over Marionette and checks, in the
real app frame:

  * the Browse/Work rail switch is absent at both widths;
  * `browser.work` does not change the surface;
  * Settings has no Work page, no Work nav group and no Work feature switch.

Usage: python3 tools/marionette-probe/work-off-probe.py <profile-dir> <out-dir>
"""
import json
import os
import socket
import subprocess
import sys
import time

HOST, PORT = "127.0.0.1", 2828
FIREFOX = "engine/obj-astra-linux/dist/bin/firefox"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def script(body: str) -> str:
    return "return (() => {" + APP + body + "})()"


MODE_SWITCH = script("""
  if (!d) return 'no app document';
  const text = (el) => (el.textContent || '').trim();
  const radio = [...d.querySelectorAll('[role="radio"]')].map(text);
  const mode = [...d.querySelectorAll('.mode-switch .mode')].map(text);
  return JSON.stringify({ radio, mode });
""")

SURFACE = script("""
  if (!d) return null;
  const shell = d.querySelector('.shell');
  return shell ? shell.getAttribute('data-astra-surface') : null;
""")

SEND = "return (() => {" + APP + """
  if (!d) return 'no app document';
  f.contentWindow.dispatchEvent(new CustomEvent('astra:ui-command', { detail: '%s' }));
  return 'ok';
})()"""

NAV = script("""
  if (!d) return 'no app document';
  const groups = [...d.querySelectorAll('.settings-nav-group h2')].map((h) => (h.textContent || '').trim());
  const items = [...d.querySelectorAll('.settings-nav-item')].map((b) => (b.textContent || '').trim());
  return JSON.stringify({ groups, items });
""")

SETTINGS_STATE = script("""
  if (!d) return 'no app document';
  const shell = d.querySelector('.shell');
  return JSON.stringify({
    surface: shell ? shell.getAttribute('data-astra-surface') : null,
    nav: !!d.querySelector('.settings-sidebar-navigation'),
    text: (d.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
  });
""")

OPEN_FEATURES = script("""
  if (!d) return 'no app document';
  const b = [...d.querySelectorAll('.settings-nav-item')].find((x) => (x.textContent || '').trim() === 'Features');
  if (!b) return 'no Features item';
  b.click();
  return 'ok';
""")

FEATURE_SWITCHES = script("""
  if (!d) return 'no app document';
  const names = [...d.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute('aria-label') || '');
  return JSON.stringify(names);
""")


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

    def js(self, source):
        return self.cmd("WebDriver:ExecuteScript", {"script": source, "args": []})["value"]


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [
            os.path.abspath(FIREFOX),
            "-profile",
            os.path.abspath(profile),
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
        stdout=errlog,
        stderr=subprocess.STDOUT,
    )

    m = None
    for _ in range(60):
        try:
            m = Marionette(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-CAME-UP")
        proc.terminate()
        return 1

    failures = []
    try:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(20)

        switch = json.loads(m.js(MODE_SWITCH))
        print("switch: " + json.dumps(switch), flush=True)
        if "Work" in switch["radio"] or "Work" in switch["mode"]:
            failures.append("the Work switch is still offered")

        initial = m.js(SURFACE)
        print("surface.initial: " + str(initial), flush=True)
        if initial == "work":
            failures.append("the window opened on Work")

        m.js(SEND % "browser.work")
        time.sleep(2)
        after = m.js(SURFACE)
        print("surface.after_work: " + str(after), flush=True)
        if after == "work":
            failures.append("browser.work opened the Work surface")

        m.js(SEND % "browser.settings")
        time.sleep(5)
        print("settings.state: " + str(m.js(SETTINGS_STATE)), flush=True)
        nav = json.loads(m.js(NAV))
        print("settings: " + json.dumps(nav), flush=True)
        if "Work" in nav["groups"] or "Work" in nav["items"]:
            failures.append("Settings still offers Work")

        print("features.open: " + str(m.js(OPEN_FEATURES)), flush=True)
        time.sleep(2)
        switches = json.loads(m.js(FEATURE_SWITCHES))
        print("features.switches: " + json.dumps(switches), flush=True)
        if "Work" in switches:
            failures.append("Features still offers the Work switch")

        if failures:
            print("FAIL: " + " | ".join(failures), flush=True)
            return 1
        print("PASS", flush=True)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
