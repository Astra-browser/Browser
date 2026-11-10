#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P5 live probe: SessionStore restores native tabs and the model adopts them."""
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
PORT = int(os.environ.get("ASTRA_SESSION_PORT", "2857"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

READY = """return JSON.stringify({host:!!window.__astraHost, mounted:document.documentElement.getAttribute('data-astra-native-mounted')})"""
LIST = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.list({request_id:'p'}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
NAV = """const url = arguments[0], id = arguments[1]; const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.loadURL({request_id:'p', astra_tab_id:id, url}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
CREATE = """const url = arguments[0]; const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.create({request_id:'p', url, background:false}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
QUIT = """try { Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return 'ok'; } catch (e) { return String(e); }"""
NATIVE = """return JSON.stringify([...gBrowser.tabs].map(t => ({ id: t.getAttribute('astra-tab-id') || null, url: (() => { try { return t.linkedBrowser?.currentURI?.spec ?? null; } catch (e) { return null; } })() })))"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b"<html><head><title>SESSION</title></head><body>session</body></html>"
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


def launch(profile):
    return subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=open(os.path.join(profile, "browser.log"), "ab"),
        stderr=subprocess.STDOUT, start_new_session=True,
    )


def connect():
    m = L.Marionette(PORT, timeout=90)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            if json.loads(m.execute(READY)).get("host"):
                return m
        except Exception:
            pass
        time.sleep(0.1)
    raise RuntimeError("host never ready")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    profile = tempfile.mkdtemp(prefix="astra-session-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("astra.gbrowser.enabled", true);\n')
    out = {}
    try:
        proc = launch(profile)
        m = connect()
        tabs = json.loads(m.execute_async(LIST)).get("tabs") or []
        first = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
        if first:
            m.execute_async(NAV, [base + "/one.html", first["astra_tab_id"]])
            time.sleep(1.0)
            out["created"] = json.loads(m.execute_async(CREATE, [base + "/two.html"]))
            time.sleep(1.0)
        out["before"] = json.loads(m.execute_async(LIST))
        out["prefs"] = json.loads(m.execute("""return JSON.stringify({startup:Services.prefs.getIntPref('browser.startup.page',-1),resume:Services.prefs.getBoolPref('browser.sessionstore.resume_from_crash',false),session:Services.prefs.getBoolPref('browser.sessionstore.restore_on_demand',false)})"""))
        out["native_before"] = json.loads(m.execute(NATIVE))
        m.execute(QUIT)
        try:
            proc.wait(timeout=20)
        except Exception:
            os.killpg(proc.pid, signal.SIGTERM)
        time.sleep(1.0)
        proc2 = launch(profile)
        m2 = connect()
        deadline = time.time() + 30
        while time.time() < deadline:
            st = json.loads(m2.execute_async(LIST))
            if len(st.get("tabs") or []) >= 2:
                break
            time.sleep(0.2)
        out["after"] = json.loads(m2.execute_async(LIST))
        out["native_after"] = json.loads(m2.execute(NATIVE))
        m2.execute(QUIT)
        try:
            proc2.wait(timeout=20)
        except Exception:
            os.killpg(proc2.pid, signal.SIGTERM)
    finally:
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    print(json.dumps(out, indent=2))
    before = out.get("before", {}).get("tabs") or []
    after = out.get("after", {}).get("tabs") or []
    native_after = out.get("native_after") if isinstance(out.get("native_after"), list) else []
    restored_back = any((t.get("can_go_back") is True or t.get("canGoBack") is True) for t in after)
    ok = (
        len(before) == 2
        and len(after) == 2
        and any((t.get("url") or "").endswith("/one.html") for t in after)
        and any((t.get("url") or "").endswith("/two.html") for t in after)
        and len(native_after) == 2
        and all(t.get("id") for t in native_after)
        and restored_back
    )
    out["restored_can_go_back"] = restored_back
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
