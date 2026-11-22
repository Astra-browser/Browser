#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live proof for the wire-completion slice (P7-T01).

Two things the contract suites cannot prove from files alone:

  1. the split surface still works after the dead divider overlay was removed
     (a real second tab, the app's own menu, the picker, native panes, the
     host's resizer elements);
  2. the window-close handshake really asks the app and closes quickly, rather
     than hanging for the 12.5 s fallback deadline.

Every step is a short chrome script, polled, so a boot-time document swap does
not kill one long evaluation (the failure mode that made the older probes
flaky here).

Usage: python3 tools/marionette-probe/wire-completion-probe.py [profile] [outdir]
Exit 0 on PASS, 1 on FAIL, 2 on SKIP (no built binary).
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

HOST, PORT = "127.0.0.1", 2828

APP = """
const frame = document.querySelector("iframe[data-astra-app-frame]");
const app = frame && frame.contentDocument;
"""

STATE = APP + """
return JSON.stringify({
  booted: document.documentElement.dataset.appBooted ?? null,
  rows: app ? app.querySelectorAll(".browse-tab[data-astra-tab-id]").length : 0,
  splits: gBrowser.splitViews.length,
  panes: gBrowser.selectedTab?.splitview?.tabs.length ?? 0,
  resizers: document.querySelectorAll(".astra-pane-resizer").length,
  menu: app ? app.querySelectorAll(".shell-menu-item").length : 0,
  picker: app ? !!app.querySelector("dialog.split-picker[open]") : false,
  splitRow: app
    ? [...app.querySelectorAll(".shell-menu-item")].some((i) => /split view/i.test(i.textContent))
    : false,
});
"""

NEW_TAB = APP + """
if (!app) throw new Error("no app");
app.querySelector(".new-tab-row").click();
return true;
"""

OPEN_MENU = APP + """
const row = app.querySelector(".browse-tab[data-astra-tab-id]");
const button = row.querySelector(".tab-open") ?? row;
const rect = button.getBoundingClientRect();
button.dispatchEvent(new (frame.contentWindow.MouseEvent)("contextmenu", {
  bubbles: true, cancelable: true, button: 2,
  clientX: rect.left + 24, clientY: rect.top + rect.height / 2,
}));
return true;
"""

CLICK_SPLIT = APP + """
const items = [...app.querySelectorAll(".shell-menu-item")];
const row = items.find((item) => /split view/i.test(item.textContent));
if (!row) throw new Error("no split row");
row.click();
return true;
"""

PICK = APP + """
const row = app.querySelector(".split-picker .picker-row:not(.picker-new)");
if (!row) throw new Error("no picker row");
row.click();
return true;
"""

UNSPLIT = """
for (const view of [...gBrowser.splitViews]) view.unsplitTabs("wire_probe");
return true;
"""


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=180)
        self._id = 0

    def _read(self):
        chunk = self.sock.recv(4096)
        if not chunk:
            raise EOFError("server closed")
        length, _, rest = chunk.partition(b":")
        need = int(length)
        while len(rest) < need:
            more = self.sock.recv(4096)
            if not more:
                raise EOFError("server closed mid-message")
            rest += more
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []}).get("value")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def poll(m, script, done, label, seconds=25, proc=None):
    end = time.time() + seconds
    last = None
    while time.time() < end:
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"browser exited during {label}")
        try:
            last = m.js(script)
            if isinstance(last, str):
                last = json.loads(last)
            if done(last):
                return last
        except Exception as error:
            last = {"error": str(error)[:200]}
        time.sleep(0.4)
    raise RuntimeError(f"timeout: {label} (last={last})")


def main():
    profile = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="astra-wire-")
    outdir = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="astra-wire-out-"))
    os.makedirs(outdir, exist_ok=True)
    binary = os.path.abspath(astra_env.BINARY)
    if not os.path.exists(binary):
        print(f"SKIP no built binary at {binary}")
        return 2
    profile = os.path.abspath(profile)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [binary, "-profile", profile, "-no-remote",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR, stdout=errlog, stderr=subprocess.STDOUT)
    print(f"launched pid={proc.pid}", flush=True)

    m = None
    for _ in range(90):
        try:
            m = Marionette(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-CAME-UP")
        proc.terminate()
        errlog.close()
        return 1

    checks = {}
    errors = []
    notes = {}
    close_seconds = None
    try:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 900})

        state = poll(m, STATE, lambda s: s.get("rows", 0) >= 1, "boot", proc=proc)
        checks["appBooted"] = True
        notes["servicesHost"] = bool(m.js("return !!(Services && Services.astraHost)"))

        m.js(NEW_TAB)
        state = poll(m, STATE, lambda s: s.get("rows", 0) >= 2, "second tab", proc=proc)
        checks["secondTab"] = state["rows"] >= 2

        m.js(OPEN_MENU)
        state = poll(m, STATE, lambda s: s.get("menu", 0) > 0, "tab menu", proc=proc)
        checks["splitRow"] = bool(state.get("splitRow"))

        m.js(CLICK_SPLIT)
        state = poll(m, STATE, lambda s: s.get("picker") is True, "split picker", proc=proc)
        checks["pickerOpened"] = bool(state.get("picker"))

        m.js(PICK)
        state = poll(m, STATE, lambda s: s.get("splits", 0) == 1, "native split", proc=proc)
        checks["splitCreated"] = state["splits"] == 1
        state = poll(m, STATE, lambda s: s.get("panes", 0) == 2, "two panes", proc=proc)
        checks["twoPanes"] = state["panes"] == 2
        time.sleep(0.6)
        state = m.js(STATE)
        state = json.loads(state) if isinstance(state, str) else state
        checks["resizers"] = state["resizers"] >= 1
        notes["resizers"] = state["resizers"]

        m.js(UNSPLIT)
        state = poll(m, STATE, lambda s: s.get("splits", 0) == 0, "split ended", proc=proc)
        checks["splitEnded"] = state["splits"] == 0
    except Exception as error:
        errors.append(str(error))

    # The close handshake: ask the window to close and time the exit. The
    # fallback deadline is 12.5 s; an answered close takes well under 2 s.
    if proc.poll() is None and m is not None:
        start = time.time()
        try:
            m.js("window.close(); return true;")
        except Exception:
            pass  # the window may go before the reply is written
        try:
            proc.wait(timeout=20)
            close_seconds = round(time.time() - start, 2)
        except Exception:
            errors.append("close: the window did not close within 20 s")
    checks["closed"] = proc.poll() is not None
    checks["closeUnderFive"] = close_seconds is not None and close_seconds < 5

    if proc.poll() is None:
        proc.terminate()
    if m is not None:
        m.close()
    errlog.close()

    report = {"checks": checks, "errors": errors, "closeSeconds": close_seconds, "notes": notes}
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps(report, indent=2), flush=True)

    failed = [name for name, ok in checks.items() if not ok] + errors
    print(f"wire completion: {len(checks) - len([n for n in checks if not checks[n]])} checks passed, {len(failed)} failed")
    for name in failed:
        print(f"FAIL {name}")
    print(f"close seconds: {close_seconds}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
