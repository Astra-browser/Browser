#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P4 multi-window probe: each window must mount and own its own native tabs."""
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
PORT = int(os.environ.get("ASTRA_MW_PORT", "2856"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

CREATE = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.create({request_id:'p', private:false}))); } catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

STATE = """return JSON.stringify((() => {
  const out = [];
  try {
    const e = Services.wm.getEnumerator('navigator:browser');
    while (e.hasMoreElements()) {
      const w = e.getNext();
      if (w.closed) continue;
      out.push({
        mounted: w.document.documentElement.getAttribute('data-astra-native-mounted'),
        stage: w.document.documentElement.getAttribute('data-astra-stage'),
        tabs: [...w.gBrowser.tabs].map(t => ({
          id: t.getAttribute('astra-tab-id') || null,
          url: (() => { try { return t.linkedBrowser?.currentURI?.spec ?? null; } catch (e) { return null; } })(),
          selected: t.selected === true,
        })),
      });
    }
  } catch (e) { return { error: String(e) }; }
  return out;
})())"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-mw-")
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
                st = json.loads(m.execute(STATE))
                if st and st[0].get("mounted") == "true":
                    break
            except Exception:
                pass
            time.sleep(0.1)
        out["before"] = json.loads(m.execute(STATE))
        out["create"] = json.loads(m.execute_async(CREATE))
        time.sleep(3.0)
        out["after"] = json.loads(m.execute(STATE))
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
    after = out.get("after") or []
    ok = (
        len(after) == 2
        and all(w.get("mounted") == "true" for w in after)
        and all(len(w.get("tabs") or []) == 1 for w in after)
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
