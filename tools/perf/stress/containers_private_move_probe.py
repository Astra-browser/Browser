#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P7b probe: private windows stay context 0; cross-space moves re-isolate."""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_P7B_PORT", "2859"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

READY = """return JSON.stringify({host:!!window.__astraHost})"""
CALL = """const method = arguments[0], args = arguments[1]; const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs[method]({request_id:'p', ...args}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
WINDOW = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.create({request_id:'p', private:true}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
NATIVE = """return JSON.stringify([...gBrowser.tabs].map(t => ({ id: t.getAttribute('astra-tab-id') || null, context: Number(t.getAttribute('usercontextid') || 0) })))"""
IDS = """return JSON.stringify(ContextualIdentityService.getPublicIdentities().map(i => ({ id: i.userContextId, name: i.name })))"""
PRIVATE = """return JSON.stringify((() => {
  const out = [];
  try {
    const e = Services.wm.getEnumerator('navigator:browser');
    while (e.hasMoreElements()) {
      const w = e.getNext();
      if (w.closed) continue;
      let priv = false;
      try { priv = w.PrivateBrowsingUtils?.isWindowPrivate?.(w) === true; } catch (e) {}
      if (!priv) continue;
      out.push([...w.gBrowser.tabs].map(t => ({ id: t.getAttribute('astra-tab-id') || null, context: Number(t.getAttribute('usercontextid') || 0) })));
    }
  } catch (e) { return { error: String(e) }; }
  return out;
})())"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-p7b-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
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
        out["space"] = json.loads(m.execute_async(CALL, ["createSpace", {"name": "Two"}]))
        time.sleep(0.8)
        tabs = json.loads(m.execute_async(CALL, ["list", {}])).get("tabs") or []
        tab = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
        out["tab"] = tab
        out["ids_before"] = json.loads(m.execute(IDS))
        out["native_space2"] = json.loads(m.execute(NATIVE))
        if tab:
            out["move_home"] = json.loads(m.execute_async(CALL, ["moveTabToSpace", {"tab": tab["astra_tab_id"], "space": "space-1"}]))
            time.sleep(0.8)
            out["native_home"] = json.loads(m.execute(NATIVE))
            out["move_back"] = json.loads(m.execute_async(CALL, ["moveTabToSpace", {"tab": tab["astra_tab_id"], "space": "space-2"}]))
            time.sleep(0.8)
            out["native_back"] = json.loads(m.execute(NATIVE))
        out["private_window"] = json.loads(m.execute_async(WINDOW))
        time.sleep(2.0)
        out["private_tabs"] = json.loads(m.execute(PRIVATE))
        out["ids_after"] = json.loads(m.execute(IDS))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
        shutil.rmtree(profile, ignore_errors=True)
    print(json.dumps(out, indent=2))
    ids = out.get("ids_before") if isinstance(out.get("ids_before"), list) else []
    space_id = next((i.get("id") for i in ids if i.get("name") == "Astra space-2"), 0)
    space_ctx = next((t.get("context") for t in out.get("native_space2") or [] if t.get("id") == (out.get("tab") or {}).get("astra_tab_id")), 0)
    home_ctx = next((t.get("context") for t in out.get("native_home") or [] if t.get("id") == (out.get("tab") or {}).get("astra_tab_id")), None)
    back_ctx = next((t.get("context") for t in out.get("native_back") or [] if t.get("id") == (out.get("tab") or {}).get("astra_tab_id")), None)
    priv = out.get("private_tabs") if isinstance(out.get("private_tabs"), list) else []
    ok = (
        space_id > 0 and space_ctx == space_id
        and home_ctx == 0 and back_ctx == space_id
        and len(priv) == 1 and all(t.get("context") == 0 for t in priv[0])
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
