"""Live probe: the hidden native tab strip follows the sidebar order.

A drag in the sidebar is a model move (`Tabs.move`). SessionStore persists the
native tab order, so the model and `gBrowser.tabs` must agree or a restart
brings the old order back and a later window.open lands beside stale
neighbours.

Usage: python3 tools/marionette-probe/tab-order-probe.py [outdir]
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
"""
import json
import os
import socket
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

ROOT = astra_env.ROOT
FIREFOX = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_TAB_ORDER_PORT", "2848"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/astra-tab-order"
os.makedirs(OUT, exist_ok=True)

if not os.path.exists(FIREFOX):
    print("SKIP no built binary at", FIREFOX)
    sys.exit(2)

def wait(read, timeout=30, step=0.2):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value

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

def main():
    profile = tempfile.mkdtemp(prefix="astra-tab-order-", dir=os.environ.get("TMPDIR", "/tmp/opencode"))
    with open(os.path.join(profile, "user.js"), "w") as prefs:
        prefs.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
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
        check(
            "app frame booted",
            wait(lambda: session.js(
                "return document.querySelector('.astra-frame')"
                "?.getAttribute('data-app-booted') === 'true';"
            ), 60) or False,
        )
        check(
            "host Tabs ready",
            wait(lambda: session.js("return !!(Services.astraHost && Services.astraHost.Tabs);"), 30) or False,
        )
        window_id = session.js(
            "return Services.astraHost.__bindCurrentWindow(document.defaultView) || 'win-1';"
        )
        for name in ("a", "b", "c"):
            session.js(
                "return Services.astraHost.Tabs.create({request_id: arguments[0],"
                " window_id: arguments[1], url: arguments[2], background: true})"
                ".then(r => JSON.stringify(r));",
                [f"order-{name}", window_id, f"https://order.test/{name}"],
            )
        time.sleep(1.5)
        state = json.loads(session.js(
            "const host = Services.astraHost;"
            "return host.Tabs.list({request_id:'order', window_id: arguments[0]})"
            ".then(r => JSON.stringify(r));",
            [window_id],
        ))
        ids = [tab["astra_tab_id"] for tab in state.get("tabs", [])]
        check("three tabs created beside the New Tab", len(ids) == 4, json.dumps(ids))
        if len(ids) != 4:
            return
        target = ids[3]
        moved = json.loads(session.js(
            "return Services.astraHost.Tabs.move({request_id:'order-move',"
            " astra_tab_id: arguments[0], index: 0}).then(r => JSON.stringify(r));",
            [target],
        ))
        check("move is admitted", moved.get("accepted") is True, json.dumps(moved))
        time.sleep(0.8)
        model = json.loads(session.js(
            "return Services.astraHost.Tabs.list({request_id:'order2', window_id: arguments[0]})"
            ".then(r => JSON.stringify(r));",
            [window_id],
        ))
        model_ids = [tab["astra_tab_id"] for tab in model.get("tabs", [])]
        native_ids = json.loads(session.js(
            "return JSON.stringify([...gBrowser.tabs]"
            ".map(t => t.getAttribute('astra-tab-id')).filter(Boolean));"
        ))
        check(
            "the native strip follows the model order",
            native_ids == model_ids,
            json.dumps({"native": native_ids, "model": model_ids}),
        )
        check("the moved tab is first", model_ids[0] == target, json.dumps(model_ids))
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

    print(f"\ntab-order: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
