#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P6a probe: an Astra permission decision reaches Services.perms."""
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
PORT = int(os.environ.get("ASTRA_PERM_PORT", "2860"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

RUN = """const done = arguments[arguments.length - 1];
(async () => {
  try {
    const { Dialogs } = await import('resource://astra/host/Dialogs.sys.mjs');
    const url = 'https://example.com/';
    const req = await Dialogs.requestPermission({
      request_id: 'perm', astra_tab_id: 'tab-1', url,
      permission: 'geolocation', actor: 'chrome',
    });
    if (req.error) return JSON.stringify({ error: req.error });
    const dec = await Dialogs.decidePermission({
      request_id: 'perm2', dialog_id: req.dialog.dialog_id,
      decision: 'grant', actor: 'chrome',
    });
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
    const allowed = Services.perms.testExactPermissionFromPrincipal(principal, 'geo');
    const req2 = await Dialogs.requestPermission({
      request_id: 'perm3', astra_tab_id: 'tab-1', url,
      permission: 'microphone', actor: 'chrome',
    });
    let denied = null;
    if (!req2.error) {
      const dec2 = await Dialogs.decidePermission({
        request_id: 'perm4', dialog_id: req2.dialog.dialog_id,
        decision: 'deny', actor: 'chrome',
      });
      denied = Services.perms.testExactPermissionFromPrincipal(principal, 'microphone');
    }
    Services.perms.removeFromPrincipal(principal, 'geo');
    Services.perms.removeFromPrincipal(principal, 'microphone');
    done(JSON.stringify({
      decision: dec, allowed, denied,
      allowAction: Services.perms.ALLOW_ACTION,
      denyAction: Services.perms.DENY_ACTION,
    }));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})()"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-perm-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
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
        time.sleep(2)
        out = json.loads(m.execute_async(RUN))
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
    ok = (
        not out.get("error")
        and out.get("allowed") == out.get("allowAction")
        and out.get("denied") == out.get("denyAction")
        and out.get("decision", {}).get("stored") is True
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
