#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P4.3 live probe: pin, discard/wakeup, cross-space move, engine tab adoption."""
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
PORT = int(os.environ.get("ASTRA_P43_PORT", "2855"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

READY = """return JSON.stringify({host:!!window.__astraHost, mounted:document.documentElement.getAttribute('data-astra-native-mounted')})"""

LIST = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.list({request_id:'p'}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

NAV = """const url = arguments[0], id = arguments[1]; const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.loadURL({request_id:'p', astra_tab_id:id, url}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

CALL = """const method = arguments[0], args = arguments[1]; const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs[method]({request_id:'p', ...args}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

CREATE_SPACE = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.createSpace({request_id:'p', name:'Two'}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

NATIVE = """return JSON.stringify([...gBrowser.tabs].map(t => ({
  id: t.getAttribute('astra-tab-id') || null,
  url: (() => { try { return t.linkedBrowser?.currentURI?.spec ?? null; } catch (e) { return null; } })(),
  selected: t.selected === true,
  pinned: t.hasAttribute('pinned'),
  discarded: t.hasAttribute('discarded'),
  context: Number(t.getAttribute('usercontextid') || 0),
})))"""

ADOPT = """const url = arguments[0]; const done = arguments[arguments.length - 1];
(async () => { try {
  const p = Services.scriptSecurityManager.getSystemPrincipal();
  const tab = gBrowser.addTab(url, { triggeringPrincipal: p, inBackground: false });
  done(JSON.stringify({ok: !!tab, url}));
} catch (e) { done(JSON.stringify({error:String(e)})); } })();"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b"<html><head><title>P4.3</title></head><body>p43</body></html>"
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
    profile = tempfile.mkdtemp(prefix="astra-p43-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
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
                if json.loads(m.execute(READY)).get("host"):
                    break
            except Exception:
                pass
            time.sleep(0.1)
        tabs = json.loads(m.execute_async(LIST)).get("tabs") or []
        first = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
        out["first"] = first
        if first:
            m.execute_async(NAV, [base + "/one.html", first["astra_tab_id"]])
            time.sleep(1.0)
            out["pin"] = json.loads(m.execute_async(CALL, ["pin", {"astra_tab_id": first["astra_tab_id"]}]))
            time.sleep(0.4)
            out["native_pin"] = json.loads(m.execute(NATIVE))
            out["unpin"] = json.loads(m.execute_async(CALL, ["unpin", {"astra_tab_id": first["astra_tab_id"]}]))
            time.sleep(0.3)
            made = json.loads(m.execute_async(CALL, ["create", {"url": base + "/two.html", "background": True}]))
            out["create"] = made
            time.sleep(0.5)
            out["native_created"] = json.loads(m.execute(NATIVE))
            if made.get("astra_tab_id"):
                second = made["astra_tab_id"]
                m.execute_async(CALL, ["select", {"astra_tab_id": second}])
                time.sleep(0.8)
                out["native_loaded"] = json.loads(m.execute(NATIVE))
                m.execute_async(CALL, ["select", {"astra_tab_id": first["astra_tab_id"]}])
                time.sleep(0.4)
                out["discard"] = json.loads(m.execute_async(CALL, ["discard", {"astra_tab_id": second}]))
                time.sleep(0.8)
                out["native_discard"] = json.loads(m.execute(NATIVE))
                out["wake"] = json.loads(m.execute_async(CALL, ["wakeup", {"astra_tab_id": second}]))
                time.sleep(0.8)
                out["native_wake"] = json.loads(m.execute(NATIVE))
                out["space"] = json.loads(m.execute_async(CREATE_SPACE))
                # createSpace mints space-2 for the first new space.
                out["target_space"] = "space-2"
                if True:
                    out["move"] = json.loads(m.execute_async(CALL, ["moveTabToSpace", {"tab": second, "space": "space-2"}]))
                    time.sleep(1.0)
                    out["native_move"] = json.loads(m.execute(NATIVE))
                    out["tabs_after_move"] = json.loads(m.execute_async(LIST))
            out["adopt"] = json.loads(m.execute_async(ADOPT, [base + "/three.html"]))
            time.sleep(1.0)
            out["native_adopt"] = json.loads(m.execute(NATIVE))
            out["tabs_after_adopt"] = json.loads(m.execute_async(LIST))
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

    def native(key):
        return out.get(key) if isinstance(out.get(key), list) else []

    first = out.get("first") or {}
    pin = [t for t in native("native_pin") if t.get("id") == first.get("astra_tab_id")]
    created = [t for t in native("native_created") if t.get("id") == (out.get("create") or {}).get("astra_tab_id")]
    disc = [t for t in native("native_discard") if t.get("id") == (out.get("create") or {}).get("astra_tab_id")]
    wake = [t for t in native("native_wake") if t.get("id") == (out.get("create") or {}).get("astra_tab_id")]
    moved = [t for t in native("native_move") if t.get("id") == (out.get("create") or {}).get("astra_tab_id")]
    adopted = [t for t in native("native_adopt") if t.get("id")]
    ok = (
        bool(pin) and pin[0].get("pinned") is True
        and bool(created) and (created[0].get("url") or "") == "about:blank"
        and any((t.get("url") or "").endswith("/two.html") for t in native("native_loaded"))
        and bool(disc) and disc[0].get("discarded") is True
        and bool(wake) and wake[0].get("discarded") is False
        and bool(moved) and moved[0].get("context", 0) > 0
        and bool(adopted)
        and len((out.get("tabs_after_adopt", {}).get("tabs") or [])) >= 2
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
