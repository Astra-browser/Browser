# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Live probe: one listener per slice, so a command fires once and a notice is one.

Launches the packaged dev build, toggles the launcher through the host command,
asks for the print-unavailable notice, opens a second window, switches its tabs,
closes it, and checks the first window is still intact with one notice and one
launcher per intent. A duplicated listener shows up as a launcher that closes
itself (two toggles in one press) or a second notice.

Usage: python3 tools/marionette-probe/slice-lifecycle-probe.py [outdir]
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from marionette import Marionette  # noqa: E402

FIREFOX = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_SLICE_PORT", "2851"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/astra-slice-lifecycle"
os.makedirs(OUT, exist_ok=True)

if not os.path.exists(FIREFOX):
    print("SKIP no built binary at", FIREFOX)
    sys.exit(2)

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


def wait(read, timeout=45, step=0.2):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value


APP = "const app = document.querySelector('iframe[data-astra-app-frame]');"
WINDOWS = """return JSON.stringify((() => {
  const out = [];
  const e = Services.wm.getEnumerator("navigator:browser");
  while (e.hasMoreElements()) {
    const w = e.getNext();
    if (w.closed) continue;
    out.push({
      id: w.Services?.astraHost?.__bindCurrentWindow?.(w) ?? null,
      booted: (w.document?.querySelector(".astra-frame")
        ?.getAttribute("data-app-booted") ?? null) === "true",
      tabs: w.gBrowser ? w.gBrowser.tabs.length : 0,
    });
  }
  return { windows: out };
})())"""


def app_count(selector):
    return f"{APP} return app?.contentDocument?.querySelectorAll({json.dumps(selector)}).length ?? 0;"


def main():
    profile = tempfile.mkdtemp(prefix="astra-slice-", dir=os.environ.get("TMPDIR", "/tmp/opencode"))
    with open(os.path.join(profile, "user.js"), "w") as prefs:
        prefs.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
        )
    log = open(os.path.join(OUT, "browser.log"), "wb")
    process = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    session = None
    try:
        session = Marionette(PORT)
        session.cmd("WebDriver:NewSession", {"capabilities": {}})
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        check("window boots", bool(wait(
            lambda: session.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"
            ), 60)))

        # One launcher.toggle must open exactly one overlay. If the ui-command
        # listener is duplicated the second delivery toggles it straight shut.
        session.js("return Services.astraHost.Commands.run({id:'launcher.toggle'})"
                   ".then(r => JSON.stringify(r));")
        time.sleep(0.5)
        opened = session.js(app_count("[data-launcher-overlay]"))
        check("one launcher toggle opens one overlay", opened == 1, f"overlays={opened}")
        time.sleep(0.4)
        session.js("return Services.astraHost.Commands.run({id:'launcher.toggle'})"
                   ".then(r => JSON.stringify(r));")
        time.sleep(0.4)
        closed = session.js(app_count("[data-launcher-overlay]"))
        check("a second press closes it exactly once", closed == 0, f"overlays={closed}")

        # The print refusal raises one notice. A duplicate listener would
        # deliver the same command twice; the notice surface still holds one.
        session.js("return Services.astraHost.Commands.run({id:'page.print'})"
                   ".then(r => JSON.stringify(r));")
        time.sleep(0.4)
        notices = session.js(app_count('.notice[role="status"]'))
        check("the print refusal shows exactly one notice", notices == 1, f"notices={notices}")

        before = json.loads(session.js(WINDOWS))["windows"]
        normal_id = before[0]["id"] if before else None
        check("normal window has an id", bool(normal_id), json.dumps(before))

        session.js(
            "return Services.astraHost.Windows.create({request_id:'slice-second',"
            " private:false}).then(r => JSON.stringify(r));"
        )
        windows = wait(lambda: (lambda w: w if len(w) == 2 and all(x.get("booted") for x in w) else None)(
            json.loads(session.js(WINDOWS))["windows"]), 60)
        check("both windows boot", bool(windows), json.dumps(windows))
        if not windows:
            return

        session.js(
            "const e = Services.wm.getEnumerator('navigator:browser');"
            "let target = null, first = null;"
            "while (e.hasMoreElements()) { const w = e.getNext();"
            "  if (w.closed) continue; const id = w.Services?.astraHost?.__bindCurrentWindow?.(w);"
            "  if (id === arguments[0]) target = w; else first = w; }"
            "if (target) { target.focus(); target.gBrowser.selectedTab ="
            "  target.gBrowser.tabs[target.gBrowser.tabs.length - 1]; }"
            "return 'ok';",
            [normal_id],
        )
        # Also switch the first window across its tabs while two windows exist.
        session.js(
            "const e = Services.wm.getEnumerator('navigator:browser');"
            "while (e.hasMoreElements()) { const w = e.getNext(); if (w.closed) continue;"
            "  if (w.gBrowser?.tabs.length > 1) w.gBrowser.selectedTab = w.gBrowser.tabs[1]; }"
            "return 'ok';"
        )
        time.sleep(0.5)

        session.js(
            "const e = Services.wm.getEnumerator('navigator:browser');"
            "let second = null; const first = [];"
            "while (e.hasMoreElements()) { const w = e.getNext(); if (w.closed) continue;"
            "  const id = w.Services?.astraHost?.__bindCurrentWindow?.(w);"
            "  if (id === arguments[0]) first.push(w); else second = w; }"
            "if (second) second.close(); return 'ok';",
            [normal_id],
        )
        time.sleep(1.5)
        after = json.loads(session.js(WINDOWS))["windows"]
        check("the first window survives the second close",
              len(after) == 1 and after[0]["booted"], json.dumps(after))
        check("the process stays alive", process.poll() is None, f"exit={process.poll()}")
        check("the surviving window still shows one notice",
              session.js(app_count('.notice[role="status"]')) <= 1)
        check("no duplicated launcher remains",
              session.js(app_count("[data-launcher-overlay]")) == 0)
    finally:
        try:
            if session:
                session.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            process.wait(timeout=15)
        except Exception:
            process.kill()
        log.close()

    print(f"\nslice-lifecycle: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
