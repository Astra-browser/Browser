#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P4.2 live probe: model tabs are mirrored by native gBrowser tabs.

Runs on the private compositor with `astra.gbrowser.enabled=true`.
Asserts: navigation reaches the native browser, the docked panel becomes
visible, create/select/close stay in sync, and mute reaches `browser.muted`.
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
PORT = int(os.environ.get("ASTRA_GBROWSER_TABS_PORT", "2853"))
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

STAGE = """return JSON.stringify((() => {
  const root = document.documentElement;
  const slot = document.querySelector('[data-astra-content]');
  const tabbox = document.getElementById('tabbrowser-tabbox');
  const rect = (el) => {
    try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
    catch (e) { return null; }
  };
  let visibility = null;
  try { visibility = getComputedStyle(tabbox).visibility; } catch (e) {}
  return {
    mounted: root.getAttribute('data-astra-native-mounted'),
    stage: root.getAttribute('data-astra-stage'),
    slot: rect(slot),
    tabbox: rect(tabbox),
    visibility,
  };
})())"""

NATIVE_TABS = """return JSON.stringify((() => {
  try {
    return [...gBrowser.tabs].map((t) => ({
      id: t.getAttribute('astra-tab-id') || null,
      url: (() => { try { return t.linkedBrowser?.currentURI?.spec ?? null; } catch (e) { return null; } })(),
      selected: t.selected === true,
      muted: (() => { try { return t.linkedBrowser?.audioMuted === true; } catch (e) { return false; } })(),
      discarded: t.hasAttribute('discarded'),
      busy: t.hasAttribute('busy'),
    }));
  } catch (e) { return { error: String(e) }; }
})())"""

LIST = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.list({request_id:'p'}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

NAV = """const url = arguments[0], id = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Navigation.loadURL({request_id:'p', astra_tab_id:id, url}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

CREATE = """const url = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.create({request_id:'p', url, background:false}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

SELECT = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.select({request_id:'p', astra_tab_id:id}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

CLOSE = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.close({request_id:'p', astra_tab_id:id}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

NATIVE_SELECT = """const index = arguments[0];
return (() => { try { const tab = gBrowser.tabs[index]; if (!tab) return 'no-tab'; gBrowser.selectedTab = tab; return 'ok'; } catch (e) { return String(e); } })();"""

NATIVE_CLOSE = """const index = arguments[0];
return (() => { try { const tab = gBrowser.tabs[index]; if (!tab) return 'no-tab'; gBrowser.removeTab(tab, { skipPermitUnload: true, closeWindowWithLastTab: false }); return 'ok'; } catch (e) { return String(e); } })();"""

MUTE = """const id = arguments[0], muted = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.setMuted({request_id:'p', astra_tab_id:id, muted}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        title = "PAGE TWO" if "two" in self.path else "PAGE ONE"
        body = f"<html><head><title>{title}</title></head><body>{title}</body></html>".encode()
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
    profile = tempfile.mkdtemp(prefix="astra-gbrowser-tabs-")
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
        out["initial_stage"] = json.loads(m.execute(STAGE))
        out["initial_native"] = json.loads(m.execute(NATIVE_TABS))
        tabs = json.loads(m.execute_async(LIST)).get("tabs") or []
        first = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
        out["first"] = first

        if first:
            m.execute_async(NAV, [base + "/one.html", first["astra_tab_id"]])
            deadline = time.time() + 15
            while time.time() < deadline:
                st = json.loads(m.execute(STAGE))
                if st.get("stage") == "page" and st.get("visibility") == "visible":
                    break
                time.sleep(0.1)
            out["after_nav_stage"] = json.loads(m.execute(STAGE))
            out["after_nav_native"] = json.loads(m.execute(NATIVE_TABS))

            made = json.loads(m.execute_async(CREATE, [base + "/two.html"]))
            out["create"] = made
            time.sleep(1.2)
            out["after_create_native"] = json.loads(m.execute(NATIVE_TABS))
            if made.get("astra_tab_id"):
                # native -> model: selecting the native tab selects the model tab
                out["native_select"] = m.execute(NATIVE_SELECT, [0])
                time.sleep(0.6)
                out["after_native_select_model"] = json.loads(m.execute_async(LIST))
                out["after_native_select_native"] = json.loads(m.execute(NATIVE_TABS))
                # native -> model: closing the native tab closes the model tab
                out["native_close"] = m.execute(NATIVE_CLOSE, [1])
                time.sleep(0.8)
                out["after_native_close_model"] = json.loads(m.execute_async(LIST))
                out["after_native_close_native"] = json.loads(m.execute(NATIVE_TABS))
                out["mute"] = json.loads(m.execute_async(MUTE, [first["astra_tab_id"], True]))
                time.sleep(0.5)
                out["after_mute_native"] = json.loads(m.execute(NATIVE_TABS))
                # model -> native: create and close again
                made2 = json.loads(m.execute_async(CREATE, [base + "/two.html"]))
                out["create_second"] = made2
                time.sleep(1.0)
                if made2.get("astra_tab_id"):
                    out["close_second"] = json.loads(m.execute_async(CLOSE, [made2["astra_tab_id"]]))
                    time.sleep(0.8)
                    out["after_close_native"] = json.loads(m.execute(NATIVE_TABS))
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

    def tabs_of(key):
        return out.get(key) if isinstance(out.get(key), list) else []

    after_nav = tabs_of("after_nav_native")
    after_create = tabs_of("after_create_native")
    after_select = tabs_of("after_select_native")
    after_mute = tabs_of("after_mute_native")
    after_close = tabs_of("after_close_native")
    stage = out.get("after_nav_stage") or {}
    slot = stage.get("slot") or {}
    tabbox = stage.get("tabbox") or {}
    ok = (
        out.get("initial_stage", {}).get("mounted") == "true"
        and stage.get("stage") == "page"
        and stage.get("visibility") == "visible"
        and abs((slot.get("x") or 0) - (tabbox.get("x") or 0)) <= 2
        and abs((slot.get("y") or 0) - (tabbox.get("y") or 0)) <= 2
        and abs((slot.get("w") or 0) - (tabbox.get("w") or 0)) <= 2
        and abs((slot.get("h") or 0) - (tabbox.get("h") or 0)) <= 2
        and any((t.get("url") or "").endswith("/one.html") for t in after_nav)
        and len(after_create) == 2
        and any(t.get("selected") and (t.get("url") or "").endswith("/one.html") for t in (out.get("after_native_select_native") or []))
        and (out.get("after_native_select_model", {}).get("selected_tab_id") == out.get("first", {}).get("astra_tab_id"))
        and len(out.get("after_native_close_model", {}).get("tabs") or []) == 1
        and any(t.get("muted") for t in after_mute)
        and len(after_close) == 1
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
