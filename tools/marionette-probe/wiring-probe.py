"""Wiring probe: drive the packaged chrome over Marionette and report what the
real UI did. Chrome context, same principal as the app iframe, so the clicks
are the same ones a person makes.

Scenarios:
  1. click Work  -> the window's surface becomes `work`, no navigation banner
  2. click Browse, open the account menu, click Notes
     -> the Notes tool panel opens (`section.shared-tool[data-tool="notes"]`)

Usage: python3 tools/marionette-probe/wiring-probe.py <profile-dir> <out-dir>
"""
import base64
import json
import os
import socket
import subprocess
import sys
import time

HOST, PORT = "127.0.0.1", 2828
FIREFOX = "engine/obj-astra-linux/dist/bin/firefox"

APP_DOC = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

CLICK_WORK = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const r = [...d.querySelectorAll('[role="radio"]')].find((x) => (x.textContent || '').trim() === 'Work');
  if (!r) return 'no Work radio';
  r.click();
  return 'ok';
})()"""

SURFACE = "return (() => {" + APP_DOC + """
  if (!d) return null;
  const shell = d.querySelector('.shell');
  return JSON.stringify({
    surface: shell ? shell.getAttribute('data-astra-surface') : null,
    banner: (d.querySelector('.navigation-error') || {}).textContent || null,
  });
})()"""

CLICK_BROWSE = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const r = [...d.querySelectorAll('[role="radio"]')].find((x) => (x.textContent || '').trim() === 'Browse');
  if (!r) return 'no Browse radio';
  r.click();
  return 'ok';
})()"""

OPEN_MENU = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const c = d.querySelector('.shelf .case');
  if (!c) return 'no account case';
  c.click();
  return 'ok';
})()"""

CLICK_TASKS = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const rows = [...d.querySelectorAll('[role="menuitem"]')];
  const n = rows.find((x) => (x.textContent || '').trim().startsWith('Tasks'));
  if (!n) return 'no Tasks row';
  n.click();
  return 'ok';
})()"""

CLICK_NOTES = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const rows = [...d.querySelectorAll('[role="menuitem"]')];
  const n = rows.find((x) => (x.textContent || '').trim().startsWith('Notes'));
  if (!n) return 'no Notes row: ' + rows.map((x) => (x.textContent || '').trim()).join('|');
  n.click();
  return 'ok';
})()"""

RELOAD = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  f.contentWindow.location.reload();
  return 'ok';
})()"""

CLOSE_TOOL = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const t = d.querySelector('section.shared-tool');
  if (!t) return 'no tool open';
  const b = [...t.querySelectorAll('header button')].pop();
  if (!b) return 'no close button';
  b.click();
  return 'ok';
})()"""

TOOL_STATE = "return (() => {" + APP_DOC + """
  if (!d) return JSON.stringify({ tool: null });
  const t = d.querySelector('section.shared-tool');
  return JSON.stringify({
    tool: t ? t.getAttribute('data-tool') : null,
    text: t ? (t.textContent || '').replace(/\s+/g, ' ').slice(0, 160) : null,
  });
})()"""


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

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
        stdout=errlog, stderr=subprocess.STDOUT)

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

    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(20)

    failures = []

    initial = json.loads(m.js(SURFACE))
    print("initial.state: " + json.dumps(initial), flush=True)

    # 1. Work is a browser surface, opened by a command.
    print("work.click: " + str(m.js(CLICK_WORK)), flush=True)
    time.sleep(2)
    state = json.loads(m.js(SURFACE))
    print("work.state: " + json.dumps(state), flush=True)
    if state.get("surface") != "work" or state.get("banner"):
        failures.append("work surface did not open cleanly")

    # Reload the chrome document so the next scenario starts on Browse.
    print("reload: " + str(m.js(RELOAD)), flush=True)
    time.sleep(10)

    # 2. A tool opens from the account menu, natively.
    print("menu.open: " + str(m.js(OPEN_MENU)), flush=True)
    time.sleep(1)
    print("menu.notes: " + str(m.js(CLICK_NOTES)), flush=True)
    time.sleep(3)
    tool = json.loads(m.js(TOOL_STATE))
    print("tool.state: " + json.dumps(tool), flush=True)
    if tool.get("tool") != "notes":
        failures.append("Notes tool did not open")

    try:
        shot = m.cmd("WebDriver:TakeScreenshot", {})
        with open(os.path.join(outdir, "wiring.png"), "wb") as f:
            f.write(base64.b64decode(shot["value"]))
        print("screenshot ok", flush=True)
    except Exception as e:
        print(f"screenshot-ERR {e}", flush=True)

    # 3. Tasks takes its empty state too (resource_call).
    print("reload2: " + str(m.js(RELOAD)), flush=True)
    time.sleep(10)
    print("menu.open2: " + str(m.js(OPEN_MENU)), flush=True)
    time.sleep(1)
    print("menu.tasks: " + str(m.js(CLICK_TASKS)), flush=True)
    time.sleep(3)
    tasks = json.loads(m.js(TOOL_STATE))
    print("tasks.state: " + json.dumps(tasks), flush=True)
    if tasks.get("tool") != "tasks":
        failures.append("Tasks tool did not open")

    print("VERDICT: " + ("PASS" if not failures else "FAIL " + "; ".join(failures)), flush=True)
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
