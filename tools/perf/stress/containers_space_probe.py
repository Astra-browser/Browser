#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P7 probe: an Astra space owns a real Firefox contextual identity."""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
PORT = int(os.environ.get("ASTRA_CONTAINER_PORT", "2858"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

READY = """return JSON.stringify({host:!!window.__astraHost, mounted:document.documentElement.getAttribute('data-astra-native-mounted')})"""
CREATE = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.createSpace({request_id:'p', name:'Two'}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
DELETE = """const space = arguments[0]; const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Tabs.deleteSpace({request_id:'p', space}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""
NATIVE = """return JSON.stringify([...gBrowser.tabs].map(t => ({ id: t.getAttribute('astra-tab-id') || null, context: Number(t.getAttribute('usercontextid') || 0) })))"""
IDS = """return JSON.stringify((() => { try { return ContextualIdentityService.getPublicIdentities().map(i => ({ id: i.userContextId, name: i.name })); } catch (e) { return { error: String(e) }; } })())"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-container-")
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
        out["create"] = json.loads(m.execute_async(CREATE))
        time.sleep(1.0)
        out["native"] = json.loads(m.execute(NATIVE))
        out["ids"] = json.loads(m.execute(IDS))
        out["delete"] = json.loads(m.execute_async(DELETE, ["space-2"]))
        time.sleep(1.2)
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
    ids = out.get("ids") if isinstance(out.get("ids"), list) else []
    space = next((i for i in ids if i.get("name") == "Astra space-2"), None)
    native = out.get("native") if isinstance(out.get("native"), list) else []
    ids_after = out.get("ids_after") if isinstance(out.get("ids_after"), list) else []
    ok = (
        space is not None
        and any(t.get("context") == space.get("id") for t in native)
        and not any(i.get("name") == "Astra space-2" for i in ids_after)
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
