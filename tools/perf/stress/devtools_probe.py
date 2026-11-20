#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""DevTools wiring probe: the toolbox acts on the stage tab, not a stand-in.

The page menu and the product keymap ask `DevToolsShim` for a toolbox. The tab
handed to the engine decides everything the toolbox does afterwards: which
container it reports, whether tab events reach it, whether `getToolboxForTab`
can find it again. A synthetic `<tab>` made the toolbox unreachable and
lifecycle-deaf (it never saw `TabClose`), and F12 could only ever open.

This probe drives the packaged build and checks, in order:

  1. F12 opens one toolbox, on the inspector, for the real `gBrowser` tab of
     the stage page;
  2. the toolbox follows a navigation of that page (a second fixture, opaque
     origin, so the engine swaps documents);
  3. a second F12 closes the toolbox (the key toggles, as the browser's own
     does);
  4. a container tab's toolbox carries that tab's `userContextId`;
  5. closing the tab closes its toolbox (the real tab's `TabClose` reaches it).

Known upstream noise, not a probe failure: `No such JSProcessActor
'DevToolsProcess'` (bug 2044741) and the `getGrids`/`pagestyle` teardown family
(bug 1944477) appear in stock Firefox too and do not stop the toolbox.

Usage: python3 tools/perf/stress/devtools_probe.py
Exit 0 PASS, 1 FAIL, 2 SKIP when the binary is absent. Stdlib only.
"""
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
MPORT = int(os.environ.get("ASTRA_DEVTOOLS_MARIONETTE", "2899"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PAGE_A = "data:text/html,<!doctype html><title>astra-devtools-a</title><body><h1>A</h1></body>"
PAGE_B = "data:text/html,<!doctype html><title>astra-devtools-b</title><body><h1>B</h1></body>"
CONTEXT_PAGE = "data:text/html,<!doctype html><title>astra-devtools-ctx</title><body>ctx</body>"

BOOT = """const s = document.querySelector('.astra-frame');
  return s ? s.getAttribute('data-app-booted') : null;"""

PRESS_F12 = """document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F12', code: 'F12', keyCode: 123, which: 123,
    bubbles: true, cancelable: true, composed: true,
  }));
  return 'sent';"""

STATE = """return (async () => {
  const { DevToolsShim } = ChromeUtils.importESModule(
    'chrome://devtools-startup/content/DevToolsShim.sys.mjs');
  const out = {
    windows: [...Services.wm.getEnumerator('devtools:toolbox')].map((w) => w.document.title),
    toolboxes: [],
    tabs: [...gBrowser.tabs].map((t) => ({
      astra: t.getAttribute('astra-tab-id'),
      selected: t.selected,
      userContextId: t.userContextId,
      url: (() => { try { return t.linkedBrowser.currentURI.spec; } catch (e) { return 'ERR'; } })(),
    })),
  };
  for (const tb of DevToolsShim.getToolboxes()) {
    let localTab = null;
    try {
      const t = tb.commands.descriptorFront.localTab;
      localTab = t ? { astra: t.getAttribute('astra-tab-id'), userContextId: t.userContextId,
                       linked: !!t.linkedBrowser } : null;
    } catch (e) {}
    out.toolboxes.push({ tool: tb.currentToolId, host: tb.hostType, localTab });
  }
  return JSON.stringify(out);
})()"""

LOAD = """const url = arguments[0];
  const b = gBrowser.selectedBrowser;
  b.fixupAndLoadURIString(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  return b.browsingContext.id;"""

ADD_CONTEXT_TAB = """const tab = gBrowser.addTab(arguments[0], {
    userContextId: 2,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    index: 1,
  });
  gBrowser.selectedTab = tab;
  return tab.getAttribute('astra-tab-id') || 'ctx-tab';"""

CLOSE_TAB = """gBrowser.removeTab(gBrowser.selectedTab, { skipPermitUnload: true });
  return 'closed';"""


def main():
    if not os.path.exists(BIN):
        print("SKIP no built binary at " + BIN)
        return 2

    profile = tempfile.mkdtemp(prefix="astra-devtools-")
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        fh.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
    log_path = os.path.join(profile, "stderr.log")
    log = open(log_path, "wb")
    proc = subprocess.Popen(
        [
            BIN,
            "-profile", profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(BIN),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    steps = []

    def step(name, ok, detail=None):
        steps.append({"name": name, "ok": ok is True, "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" :: {detail}" if detail else ""))

    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(240)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 120
        while time.time() < deadline:
            if m.execute(BOOT) == "true":
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Astra app never booted")

        m.execute(LOAD, [PAGE_A])
        time.sleep(2.5)

        # 1. open on the stage tab
        m.execute(PRESS_F12)
        time.sleep(4)
        open_state = json.loads(m.execute(STATE))
        toolbox = (open_state["toolboxes"] or [None])[0] or {}
        step("F12 opens one toolbox", open_state["windows"] and len(open_state["toolboxes"]) == 1,
             open_state)
        step("the toolbox opens on the inspector", toolbox.get("tool") == "inspector", toolbox)
        step("the toolbox attaches to the real stage tab",
             (toolbox.get("localTab") or {}).get("astra") == "tab-1"
             and (toolbox.get("localTab") or {}).get("linked") is True,
             toolbox.get("localTab"))

        # 2. follow a navigation
        m.execute(LOAD, [PAGE_B])
        time.sleep(4)
        nav_state = json.loads(m.execute(STATE))
        titles = " ".join(nav_state["windows"])
        step("the toolbox follows the stage to the next page",
             "astra-devtools-b" in titles and "astra-devtools-a" not in titles,
             nav_state["windows"])

        # 3. toggle closed
        m.execute(PRESS_F12)
        time.sleep(3)
        closed = json.loads(m.execute(STATE))
        step("a second F12 closes the toolbox",
             closed["windows"] == [] and closed["toolboxes"] == [], closed)

        # 4. container tab
        m.execute(ADD_CONTEXT_TAB, [CONTEXT_PAGE])
        time.sleep(2.5)
        m.execute(PRESS_F12)
        time.sleep(4)
        ctx_state = json.loads(m.execute(STATE))
        ctx_tab = (ctx_state["toolboxes"] or [{}])[0].get("localTab") or {}
        step("a container tab's toolbox carries its container",
             ctx_tab.get("userContextId") == 2, ctx_state)

        # 5. tab close tears the toolbox down
        m.execute(CLOSE_TAB)
        time.sleep(3)
        gone = json.loads(m.execute(STATE))
        step("closing the tab closes its toolbox",
             gone["windows"] == [] and gone["toolboxes"] == [], gone)

        try:
            m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:  # noqa: BLE001
            pass
    except Exception as error:  # noqa: BLE001
        step("probe ran to completion", False, str(error))
    finally:
        log.close()
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        # Upstream noise is reported, never counted as a failure (see header).
        noise = {}
        try:
            text = open(log_path, "rb").read().decode("utf-8", "replace")
            noise = {
                "no_such_actor_bug_2044741": text.count("No such JSProcessActor"),
                "teardown_bug_1944477": text.count("Connection closed, pending request")
                + text.count("already destroyed actor"),
                "target_lookup_miss": text.count("Unable to find target with innerWindowId"),
            }
        except OSError:
            pass
        if all(s["ok"] for s in steps):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)

    passed = bool(steps) and all(s["ok"] for s in steps)
    print(json.dumps({"steps": steps, "upstream_noise": noise}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
