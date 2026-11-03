#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live probe: native stop and zoom reach the real content browser.

Runs headed on the private Weston display:
  tools/perf/hidden-display.sh python3 tools/perf/stress/native_nav_probe.py

Starts a slow endpoint (headers delayed 4 s), asks Navigation.stop() while it
is in flight, and checks the page did not commit. Then loads a fast page,
sets zoom 1.5 and reads ZoomManager back from the mounted <browser>.
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
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ROOT, "engine", "obj-astra-linux", "dist", "bin", "firefox"))
PORT = int(os.environ.get("ASTRA_NATIVE_NAV_PORT", "2850"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.hits = getattr(self.server, "hits", 0) + 1
        if self.path.startswith("/slow"):
            time.sleep(4.0)
            body = b"<html><head><title>SLOW PAGE</title></head><body>slow</body></html>"
        elif self.path.startswith("/cached"):
            body = (
                f"<html><head><title>CACHED PAGE</title></head>"
                f"<body>hit {self.server.hits}</body></html>"
            ).encode()
        else:
            body = b"<html><head><title>FAST PAGE</title></head><body>fast</body></html>"
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("cache-control", "max-age=3600")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


APP_READY = """return JSON.stringify((() => {
  try {
    return {
      host: !!window.__astraHost,
      frame: !!document.querySelector('iframe[data-astra-app-frame]'),
      rootKids: document.querySelector('iframe[data-astra-app-frame]')?.contentDocument?.querySelector('#root')?.children.length ?? 0,
    };
  } catch (e) { return { error: String(e) }; }
})())"""

LIST = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.list({request_id:'p'}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

NAV = """const url = arguments[0], id = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.loadURL({request_id:'p', astra_tab_id:id, url}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

HARD = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.hardReload({request_id:'p', astra_tab_id:id}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

STOP = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.stop({request_id:'p', astra_tab_id:id}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

ZOOM = """const id = arguments[0], z = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.setZoom({request_id:'p', astra_tab_id:id, zoom:z}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

STATE = """return JSON.stringify((() => {
  const b = document.querySelector('browser[data-astra-browser]');
  let zoom = null, fullZoom = null;
  try { zoom = window.ZoomManager?.getZoomForBrowser?.(b) ?? null; } catch (e) {}
  try { fullZoom = b?.fullZoom ?? null; } catch (e) {}
  return {
    uri: (() => { try { return b?.currentURI?.spec ?? null; } catch (e) { return null; } })(),
    title: (() => { try { return b?.contentTitle ?? null; } catch (e) { return null; } })(),
    loading: (() => { try { return b?.webProgress?.isLoadingDocument ?? null; } catch (e) { return null; } })(),
    zoom, fullZoom,
  };
})())"""


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    profile = tempfile.mkdtemp(prefix="astra-native-nav-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
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
        ready = None
        while time.time() < deadline:
            try:
                ready = json.loads(m.execute(APP_READY))
                if ready.get("host") and ready.get("frame") and (ready.get("rootKids") or 0) > 0:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        out["ready"] = ready
        tabs = json.loads(m.execute_async(LIST)).get("tabs") or []
        tab = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
        out["tab"] = tab
        if not tab:
            raise RuntimeError("no tab")

        # --- stop a slow in-flight load -----------------------------------
        m.execute_async(NAV, [base + "/slow", tab["astra_tab_id"]])
        time.sleep(0.7)
        out["stop_result"] = json.loads(m.execute_async(STOP, [tab["astra_tab_id"]]))
        time.sleep(5.0)
        out["after_stop"] = json.loads(m.execute(STATE))
        out["stop_worked"] = out["after_stop"].get("title") != "SLOW PAGE"
        listed = json.loads(m.execute_async(LIST)).get("tabs") or []
        out["stop_model_loading"] = next(
            (t.get("loading") for t in listed if t.get("astra_tab_id") == tab["astra_tab_id"]),
            None,
        )
        out["stop_model_cleared"] = out["stop_model_loading"] is False

        # --- zoom the live browser ---------------------------------------
        m.execute_async(NAV, [base + "/fast", tab["astra_tab_id"]])
        deadline = time.time() + 15
        while time.time() < deadline:
            st = json.loads(m.execute(STATE))
            if st.get("title") == "FAST PAGE" and st.get("loading") is False:
                break
            time.sleep(0.1)
        out["before_zoom"] = json.loads(m.execute(STATE))
        out["zoom_result"] = json.loads(m.execute_async(ZOOM, [tab["astra_tab_id"], 1.5]))
        time.sleep(0.7)
        out["after_zoom"] = json.loads(m.execute(STATE))
        z = out["after_zoom"].get("zoom")
        out["zoom_worked"] = z is not None and float(z) > 1.0

        # --- hard reload bypasses the cache ------------------------------
        before_hits = server.hits
        m.execute_async(NAV, [base + "/cached.html", tab["astra_tab_id"]])
        deadline = time.time() + 15
        while time.time() < deadline:
            st = json.loads(m.execute(STATE))
            if st.get("title") == "CACHED PAGE" and st.get("loading") is False:
                break
            time.sleep(0.1)
        first_hits = server.hits - before_hits
        before_hits = server.hits
        m.execute_async(HARD, [tab["astra_tab_id"]])
        deadline = time.time() + 15
        while time.time() < deadline:
            st = json.loads(m.execute(STATE))
            if st.get("title") == "CACHED PAGE" and st.get("loading") is False:
                break
            time.sleep(0.1)
        second_hits = server.hits - before_hits
        out["reload_hits"] = {"first": first_hits, "hard": second_hits}
        out["hard_reload_worked"] = second_hits >= 1
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
    ok = (
        out.get("stop_worked")
        and out.get("stop_model_cleared")
        and out.get("zoom_worked")
        and out.get("hard_reload_worked")
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
