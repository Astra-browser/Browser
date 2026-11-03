#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P4 spike: the native tabbrowser deck docks over the Astra content slot.

Runs headed on the private compositor. The pref is enabled for this probe
only; the panel must stay hidden until `Content.mountNative` marks it mounted.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
PORT = int(os.environ.get("ASTRA_GBROWSER_PORT", "2852"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

APP_READY = """return JSON.stringify((() => {
  try {
    return {
      host: !!window.__astraHost,
      frame: !!document.querySelector('iframe[data-astra-app-frame]'),
      rootKids: document.querySelector('iframe[data-astra-app-frame]')?.contentDocument?.querySelector('#root')?.children.length ?? 0,
    };
  } catch (e) { return { error: String(e) }; }
})())"""

NAV = """const url = arguments[0], id = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.loadURL({request_id:'p', astra_tab_id:id, url}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

LIST = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.list({request_id:'p'}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

STAGE = """return JSON.stringify((() => {
  const root = document.documentElement;
  const slot = document.querySelector('[data-astra-content]');
  const tabbox = document.getElementById('tabbrowser-tabbox');
  const toolbox = document.getElementById('navigator-toolbox');
  const rect = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { return null; }
  };
  const style = (el) => {
    try { const s = getComputedStyle(el); return { display: s.display, visibility: s.visibility }; } catch (e) { return null; }
  };
  return {
    gbrowser: root.getAttribute('data-astra-gbrowser'),
    stage: root.getAttribute('data-astra-stage'),
    mounted: root.getAttribute('data-astra-native-mounted'),
    vars: {
      x: root.style.getPropertyValue('--astra-stage-x'),
      y: root.style.getPropertyValue('--astra-stage-y'),
      w: root.style.getPropertyValue('--astra-stage-w'),
      h: root.style.getPropertyValue('--astra-stage-h'),
    },
    slot: rect(slot),
    tabbox: rect(tabbox),
    tabboxStyle: style(tabbox),
    toolboxStyle: style(toolbox),
  };
})())"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b"<html><head><title>STAGE PAGE</title></head><body>stage</body></html>"
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    profile = tempfile.mkdtemp(prefix="astra-gbrowser-stage-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        fh.write('user_pref("astra.gbrowser.enabled", true);\n')
    log = open(os.path.join(profile, "browser.log"), "wb")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    out = {}
    try:
        m = L.Marionette(PORT, timeout=90)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                ready = json.loads(m.execute(APP_READY))
                if ready.get("host") and ready.get("frame") and (ready.get("rootKids") or 0) > 0:
                    out["ready"] = ready
                    break
            except Exception:
                pass
            time.sleep(0.1)
        time.sleep(0.5)
        tabs = json.loads(m.execute_async(LIST)).get("tabs") or []
        tab = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
        if tab:
            m.execute_async(NAV, [base + "/page.html", tab["astra_tab_id"]])
            deadline = time.time() + 15
            while time.time() < deadline:
                st = json.loads(m.execute(STAGE))
                if (st.get("slot") or {}).get("w"):
                    break
                time.sleep(0.1)
        out["stage"] = json.loads(m.execute(STAGE))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        server.shutdown()
        log.close()
        shutil.rmtree(profile, ignore_errors=True)
    print(json.dumps(out, indent=2))
    st = out.get("stage") or {}
    slot = st.get("slot") or {}
    tab = st.get("tabbox") or {}
    ok = (
        st.get("gbrowser") == "true"
        and st.get("stage") == "app"
        and st.get("mounted") is None
        and st.get("tabboxStyle", {}).get("visibility") == "hidden"
        and st.get("tabboxStyle", {}).get("display") != "none"
        and st.get("toolboxStyle", {}).get("display") == "none"
        and abs((slot.get("x") or 0) - (tab.get("x") or 0)) <= 2
        and abs((slot.get("y") or 0) - (tab.get("y") or 0)) <= 2
        and abs((slot.get("w") or 0) - (tab.get("w") or 0)) <= 2
        and abs((slot.get("h") or 0) - (tab.get("h") or 0)) <= 2
        and (slot.get("w") or 0) > 0
        and (slot.get("h") or 0) > 0
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
