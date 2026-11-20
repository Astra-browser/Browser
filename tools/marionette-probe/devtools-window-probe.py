#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""DevTools window probe: Inspect opens in a window a person can work in.

The engine's `toolbox-window.xhtml` is 900x320 and persists that size, so
Astra (which always uses the window host because the native tabbox is hidden)
used to open DevTools as a strip. The product now grows a degenerate toolbox
and centres it over the browser window while leaving a size the person chose
alone. This probe drives the packaged build and checks, in order:

  1. F12 opens one toolbox window;
  2. it is at least 760x420 CSS px and fully on the work area;
  3. reopening keeps that size (no fight with the person's window);
  4. shrinking it below usable and reopening grows it back;
  5. a usable size and position the person set is kept exactly.

Exit 0 PASS, 1 FAIL, 2 SKIP when the binary is absent. Stdlib only.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "..", "perf", "stress"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import astra_env  # noqa: E402
import load_state as L  # noqa: E402

BIN = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_DEVTOOLS_WINDOW_MARIONETTE", "2898"))
PAGE = "data:text/html,<title>devtools-window-fixture</title><h1>fixture</h1>"
MIN_W = 760
MIN_H = 420

F12 = """document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F12', code: 'F12', keyCode: 123, which: 123,
    bubbles: true, cancelable: true, composed: true,
  }));
  return 'sent';"""

STATE = """const boxes = [...Services.wm.getEnumerator('devtools:toolbox')];
  return JSON.stringify({
    browser: { x: window.screenX, y: window.screenY,
               w: window.outerWidth, h: window.outerHeight,
               sx: screen.availLeft, sy: screen.availTop,
               sw: screen.availWidth, sh: screen.availHeight },
    toolboxes: boxes.map((w) => ({ x: w.screenX, y: w.screenY,
      w: w.outerWidth, h: w.outerHeight, inner: [w.innerWidth, w.innerHeight] })),
  });"""

LOAD = """const url = arguments[0];
  const b = gBrowser.selectedBrowser;
  b.fixupAndLoadURIString(url, { triggeringPrincipal:
    Services.scriptSecurityManager.getSystemPrincipal() });
  return b.browsingContext.id;"""

RESIZE = """const w = [...Services.wm.getEnumerator('devtools:toolbox')][0];
  if (!w) return 'none';
  w.resizeTo(arguments[0], arguments[1]);
  w.moveTo(arguments[2], arguments[3]);
  return 'ok';"""

CLOSE = """const { DevToolsShim } = ChromeUtils.importESModule(
    'chrome://devtools-startup/content/DevToolsShim.sys.mjs');
  const tb = DevToolsShim.getToolboxes()[0];
  if (tb) tb.destroy();
  return 'closed';"""


def main():
    if not os.path.exists(BIN):
        print("SKIP no built binary at " + BIN)
        return 2
    profile = tempfile.mkdtemp(prefix="astra-devtools-window-")
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        fh.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
    log = open(os.path.join(profile, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT)
    steps = []

    def step(name, ok, detail=None):
        steps.append({"name": name, "ok": ok is True, "detail": detail})
        print(("PASS " if ok else "FAIL ") + name
              + ("" if ok else f" :: {detail}" if detail else ""))

    m = None
    try:
        m = L.Marionette(PORT, timeout=150)
        m.sock.settimeout(240)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 150
        while time.time() < deadline:
            if m.execute("""const s = document.querySelector('.astra-frame');
                return s ? s.getAttribute('data-app-booted') : null;""") == "true":
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Astra app never booted")
        m.execute(LOAD, [PAGE])
        time.sleep(2)

        def state():
            return json.loads(m.execute(STATE))

        def toolbox():
            boxes = state()["toolboxes"]
            return boxes[0] if boxes else None

        def open_tools(expect_new=True):
            before = toolbox()
            m.execute(F12)
            deadline = time.time() + 20
            found = None
            while time.time() < deadline:
                now = toolbox()
                if now and (not expect_new or before is None or now != before):
                    found = now
                    break
                time.sleep(0.1)
            if found is not None:
                # The product re-places the window while the engine's own
                # persisted-size restore and the toolbox load settle.
                settle = time.time() + 8
                while time.time() < settle:
                    now = toolbox()
                    if now and now["w"] >= MIN_W and now["h"] >= MIN_H:
                        break
                    time.sleep(0.1)
            return toolbox()

        base = state()["browser"]
        first = open_tools()
        step("F12 opens one toolbox window", first is not None, state())
        if first:
            step("the toolbox is at least %dx%d" % (MIN_W, MIN_H),
                 first["w"] >= MIN_W and first["h"] >= MIN_H, first)
            inside = (
                first["x"] >= base["sx"]
                and first["y"] >= base["sy"]
                and first["x"] + first["w"] <= base["sx"] + base["sw"]
                and first["y"] + first["h"] <= base["sy"] + base["sh"]
            )
            step("the toolbox is fully on the work area", inside, {"window": first, "screen": base})

        m.execute(CLOSE)
        time.sleep(2)
        second = open_tools()

        def same_size(a, b):
            return bool(
                a and b and abs(a["w"] - b["w"]) <= 2 and abs(a["h"] - b["h"]) <= 2
            )

        step("reopening keeps the size", same_size(first, second),
             {"first": first, "second": second})

        m.execute(RESIZE, [900, 300, 0, 0])
        time.sleep(1)
        m.execute(CLOSE)
        time.sleep(2)
        third = open_tools()
        step("a sliver is grown back on the next open", bool(third and third["h"] >= MIN_H), third)

        m.execute(RESIZE, [1000, 700, 60, 60])
        time.sleep(1)
        m.execute(CLOSE)
        time.sleep(2)
        fourth = open_tools()
        kept = bool(
            fourth
            and abs(fourth["w"] - 1000) <= 2
            and abs(fourth["h"] - 700) <= 2
            and abs(fourth["x"] - 60) <= 2
            and abs(fourth["y"] - 60) <= 2
        )
        step("a usable size and position the person set is kept", kept, fourth)

        try:
            m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:  # noqa: BLE001
            pass
    except Exception as error:  # noqa: BLE001
        step("probe ran to completion", False, str(error))
    finally:
        log.close()
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        if all(s["ok"] for s in steps):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print("profile kept: " + profile, file=sys.stderr)

    passed = bool(steps) and all(s["ok"] for s in steps)
    print(json.dumps({"steps": steps}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
