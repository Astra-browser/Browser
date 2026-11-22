"""Live probe: every registry page mounts its own component and returns.

The surface registry (P7-T03) replaced the Shell's per-page `{#if}` chain with
one table. A wrong loader would still render a page: an id with no branch used
to fall through to the downloads library. This probe opens Settings, History,
Downloads and Gallery through the real `browser.<id>` command and reads the
mounted stage in the app frame, then returns and checks the stage is gone.

Usage:

    python3 tools/marionette-probe/surface-registry-probe.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2898
FIREFOX = astra_env.BINARY

PAGES = ("settings", "history", "downloads", "gallery")

# Which component each page owns, read from the mounted stage. Settings and
# Gallery each have a section class no other page uses; History and Downloads
# share the library shell, so Downloads is told apart by `data-library` and
# History by the absence of the gallery and downloads markers.
STATE = """return (()=>{
  const app = document.querySelector('iframe[data-astra-app-frame]');
  const doc = app && app.contentDocument;
  if (!doc) return JSON.stringify({ surface: null, page: null });
  const shell = doc.querySelector('.shell');
  const stage = doc.querySelector('.stage-page');
  const id = stage && stage.getAttribute('data-page');
  const root = id === arguments[0] ? stage : null;
  return JSON.stringify({
    surface: shell && shell.getAttribute('data-astra-surface'),
    page: id,
    settings: !!(root && root.querySelector('.settings-shell')),
    history: !!(root && root.querySelector('.library-shell') && !root.querySelector('.gallery-shell') && !root.querySelector('[data-library]')),
    downloads: !!(root && root.querySelector('.library-shell[data-library="downloads"]')),
    gallery: !!(root && root.querySelector('.gallery-shell')),
  });
})()"""


class Marionette:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
        self.file = self.sock.makefile("rb")
        self.seq = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.file.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.file.read(length - len(rest))
            if not chunk:
                raise EOFError("marionette closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self.seq += 1
        payload = json.dumps([0, self.seq, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            message = self._read()
            if isinstance(message, list) and len(message) == 4 and message[1] == self.seq:
                if message[2]:
                    raise RuntimeError(f"{method} -> {message[2]}: {json.dumps(message[3])[:300]}")
                return message[3]

    def js(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]


def wait(read, timeout=25, step=0.2):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value


def view(session, page):
    return json.loads(session.js(STATE, [page]))


def main():
    astra_env.require()
    failures = []
    profile = tempfile.mkdtemp(prefix="astra-surface-registry-")
    with open(os.path.join(profile, "prefs.js"), "w") as prefs:
        prefs.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
        )
    log = open(os.path.join(profile, "log"), "wb")
    process = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT)
    session = None
    try:
        session = Marionette(PORT)
        session.cmd("WebDriver:NewSession", {"capabilities": {}})
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        if not wait(lambda: session.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"), 90):
            failures.append("the Astra app frame never booted")
        time.sleep(2)

        print("build:", astra_env.describe())
        for page in PAGES:
            result = session.js(
                "return Services.astraHost.Commands.run({id:'browser.' + arguments[0]});", [page])
            print(page, "open ->", json.dumps(result)[:120])
            opened = wait(lambda: (lambda v: v if v.get("page") == page and v.get(page) else None)(
                view(session, page)), 30)
            if not opened:
                failures.append(f"{page}: its stage never mounted")
                continue
            print(page, "mounted ->", opened)
            if opened.get("surface") != page:
                failures.append(f"{page}: data-astra-surface is {opened.get('surface')}")
            for other in PAGES:
                if other != page and opened.get(other):
                    failures.append(f"{page}: mounted {other}'s component instead")

            session.js("return Services.astraHost.Commands.run({id:'browser.return'});")
            returned = wait(lambda: (lambda v: v if v.get("surface") == "browse" and v.get("page") is None else None)(
                view(session, page)), 20)
            if not returned:
                failures.append(f"{page}: the page did not return ({view(session, page)})")
            else:
                print(page, "return ->", returned)

        print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
        return 0 if not failures else 1
    finally:
        try:
            session.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        time.sleep(0.5)
        try:
            process.terminate()
            process.wait(timeout=10)
        except Exception:
            pass


sys.exit(main())
