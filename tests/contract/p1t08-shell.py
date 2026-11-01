#!/usr/bin/env python3
"""P1-T08 contract test: Astra shell mounted in the main browser window.

Launches the built Astra binary via the in-tree geckodriver, switches to
Marionette chrome context (the main browser window), and asserts
(docs/astra/PARITY.md P1-T08, U-04 resolved):
  - #astra-root exists and the Svelte hello bundle rendered into it
    (proves the chrome-privileged ES module loaded under chrome CSP)
  - #navigator-toolbox is hidden (Firefox chrome out of sight)
  - #tabbrowser-tabbox is hidden (content slot closed until P1-T10)

Usage: python3 tests/contract/p1t08-shell.py
Exit 0 on PASS, 1 on FAIL. Stdlib only.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, "engine")
FIREFOX = os.path.join(ENGINE, "obj-astra-linux", "dist", "bin", "firefox")
GECKODRIVER = os.path.join(ENGINE, "obj-astra-linux", "dist", "host", "bin", "geckodriver")
PORT = 44450


def wd(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)["value"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}")


def main():
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            print(f"SKIP: missing {f} (run a full build first)")
            return 1
    profile = tempfile.mkdtemp(prefix="astra-p1t08-")
    gd = subprocess.Popen(
        [GECKODRIVER, "--port", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=2)
                break
            except OSError:
                time.sleep(0.2)
        session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {
            "moz:firefoxOptions": {
                "binary": FIREFOX,
                "args": ["--headless", "--no-remote",
                         "-remote-allow-system-access",
                         "--profile", profile],
            }}}})["sessionId"]
        try:
            for _ in range(100):
                try:
                    wd("GET", f"/session/{session}/title")
                    break
                except RuntimeError:
                    time.sleep(0.3)
            # Main browser window lives in chrome context.
            wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
            res = wd("POST", f"/session/{session}/execute/sync", {
                "script": """const S = (typeof Services !== "undefined") ? Services
                      : ChromeUtils.importESModule(
                      "resource://gre/modules/Services.sys.mjs").Services;
                    const win = S.wm.getMostRecentWindow("navigator:browser");
                    const d = win.document;
                    const root = d.getElementById("astra-root");
                    const r = root ? root.getBoundingClientRect() : null;
                    const cs = (id) => {
                      const el = d.getElementById(id);
                      return el ? win.getComputedStyle(el).display : "MISSING";
                    };
                    return {
                      rootExists: !!root,
                      rootWidth: r ? r.width : 0,
                      rootHeight: r ? r.height : 0,
                      rootChildren: root ? root.childElementCount : 0,
                      rootText: root ? root.textContent.slice(0, 120) : "",
                      // Assembled shell (P3-T13) mounts frame/tabstrip/urlbar
                      // before the about block, so "Hello Tab" sits past the
                      // 120-char probe: full text keeps the same assertion.
                      rootTextFull: root ? root.textContent.slice(0, 4000) : "",
                      toolboxDisplay: cs("navigator-toolbox"),
                      tabboxDisplay: cs("tabbrowser-tabbox"),
                    };""",
                "args": [],
            })
            print("observed:", json.dumps(res, indent=1))
            checks = [
                ("#astra-root exists", res.get("rootExists") is True),
                ("#astra-root has size (no 0x0 XUL fixed-pos collapse, D-30)",
                 res.get("rootWidth", 0) > 100 and res.get("rootHeight", 0) > 100),
                ("Svelte hello rendered in #astra-root",
                 res.get("rootChildren", 0) > 0
                 and "Hello Tab" in res.get("rootTextFull", res.get("rootText", ""))),
                ("#navigator-toolbox hidden",
                 res.get("toolboxDisplay") == "none"),
                ("#tabbrowser-tabbox hidden",
                 res.get("tabboxDisplay") == "none"),
            ]
            failed = [name for name, ok in checks if not ok]
            for name, ok in checks:
                print(("PASS " if ok else "FAIL ") + name)
            if failed:
                print(f"P1-T08 contract: FAIL ({len(failed)} checks)")
                return 1
            print("P1-T08 contract: PASS (U-04 resolved)")
            return 0
        finally:
            wd("DELETE", f"/session/{session}")
    finally:
        gd.terminate()


if __name__ == "__main__":
    sys.exit(main())
