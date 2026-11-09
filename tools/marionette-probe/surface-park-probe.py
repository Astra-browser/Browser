"""Live probe: leaving an app page back to a web tab repaints the real page.

A browser page (Settings, History, …) is a tab of its own. Choosing a web tab
parks the page instead of walking back through `browser.return`, so no host
command reports the change: the app has to tell the shell which surface is in
front. When it did not, `data-internal` stayed on the content slot, the native
stage stayed hidden and every web page after Settings painted as a dark pane.

Steps: open a local page → open Settings → choose the web tab by clicking it →
open one more page. Usage:

    python3 tools/marionette-probe/surface-park-probe.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 2896
ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><title>Surface probe</title><h1>content</h1>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


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


def wait(read, timeout=30, step=0.25):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value


STATE = """return (()=>{
  const frame = document.querySelector('.astra-frame');
  const slot = document.querySelector('[data-astra-content]');
  const app = document.querySelector('iframe[data-astra-app-frame]');
  const doc = app && app.contentDocument;
  return JSON.stringify({
    booted: frame?.getAttribute('data-app-booted') ?? null,
    surface: doc?.querySelector('.shell')?.getAttribute('data-astra-surface') ?? null,
    stage: document.documentElement.getAttribute('data-astra-stage'),
    internal: slot?.dataset.internal ?? null,
    hasPage: slot?.dataset.hasPage ?? null,
    display: slot ? doc?.defaultView.getComputedStyle(slot).display : null,
  });
})()"""


def state(session):
    return json.loads(session.js(STATE))


def main():
    failures = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    profile = tempfile.mkdtemp(prefix="astra-surface-park-")
    with open(os.path.join(profile, "prefs.js"), "w") as prefs:
        prefs.write(f'user_pref("marionette.port", {PORT});\n')
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
        wait(lambda: session.js(
            "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"), 60)
        time.sleep(3)

        listing = session.js("return Services.astraHost.Tabs.list({request_id:'p'}).then(r=>JSON.stringify(r));")
        tab = json.loads(listing)["tabs"][0]
        tab_id = tab.get("id") or tab.get("astra_tab_id")
        session.js(
            "return Services.astraHost.Navigation.loadURL({request_id:'n',astra_tab_id:arguments[0],url:arguments[1]});",
            [tab_id, url])
        if not wait(lambda: session.js(
                "return document.documentElement.getAttribute('data-astra-stage') === 'page';"), 30):
            failures.append("the first web page never reached the stage")
        time.sleep(1)

        session.js("return Services.astraHost.Commands.run({id:'browser.settings'});")
        wait(lambda: state(session)["surface"] == "settings", 15)
        time.sleep(0.4)
        opened = state(session)
        print("settings", opened)
        if opened["internal"] != "true" or opened["stage"] != "app":
            failures.append(f"Settings did not take the stage ({opened['stage']}/{opened['internal']})")

        # Choose the web tab in the app's column the way a person does. The
        # row wrapper carries the id; the button inside it is the target.
        clicked = session.js("""return (()=>{
          const app = document.querySelector('iframe[data-astra-app-frame]');
          const doc = app && app.contentDocument;
          const row = [...(doc?.querySelectorAll('[data-astra-tab-id]') ?? [])]
            .find((entry) => entry.getAttribute('data-astra-tab-url'));
          if (!row) return 'missing';
          const control = row.querySelector('.tab-open') || row.querySelector('.rail-item') || row;
          control.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, view: doc.defaultView,
          }));
          return 'clicked';
        })()""")
        print("web tab", clicked)
        if clicked != "clicked":
            failures.append("the web tab row was not in the column")
        time.sleep(1.2)
        back = state(session)
        print("back on the page", back)
        if back["surface"] != "browse":
            failures.append(f"the web tab did not take the window ({back['surface']})")
        if back["internal"] == "true":
            failures.append("the page surface stayed hidden after parking the page")
        if back["stage"] != "page":
            failures.append(f"the native page did not come back to the stage ({back['stage']})")
        if back["display"] == "none":
            failures.append("the content slot stayed display:none over the web page")

        # A page opened after the round trip has to paint too.
        created = session.js("return Services.astraHost.Tabs.create({request_id:'c',url:'about:blank'}).then(r=>JSON.stringify(r));")
        new_id = json.loads(created).get("astra_tab_id")
        session.js(
            "return Services.astraHost.Navigation.loadURL({request_id:'n2',astra_tab_id:arguments[0],url:arguments[1]});",
            [new_id, url + "second"])
        time.sleep(1)
        later = state(session)
        print("a page opened after Settings", later)
        if later["stage"] != "page" or later["internal"] == "true":
            failures.append(f"a page opened after Settings did not paint ({later['stage']}/{later['internal']})")

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
        server.shutdown()


sys.exit(main())
