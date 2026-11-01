#!/usr/bin/env python3
"""P1-T06 contract test: policies + prefs take effect in a fresh profile.

Launches the built Astra binary via the in-tree geckodriver, switches to
Marionette chrome context, and asserts (docs/astra/PRIVACY_PREFS.md):
  - Services.policies.status == ACTIVE (1): policies.json was picked up
  - datareporting.healthreport.uploadEnabled is LOCKED false (policy lock)
  - app.normandy.enabled is LOCKED false (mozilla.cfg autoconfig lockPref)

Usage: python3 tests/contract/p1t06-prefs.py
Exit 0 on PASS, 1 on FAIL. Stdlib only.
"""
import json
import os
import shutil
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
PORT = 44444


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
    profile = tempfile.mkdtemp(prefix="astra-p1t06-")
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
            # Wait for Marionette to be driving the browser before switching
            # out of content context (else geckodriver answers 500).
            for _ in range(100):
                try:
                    wd("GET", f"/session/{session}/title")
                    break
                except RuntimeError:
                    time.sleep(0.3)
            wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
            res = wd("POST", f"/session/{session}/execute/sync", {
                "script": """const S = (typeof Services !== "undefined") ? Services
                    : ChromeUtils.importESModule(
                      "resource://gre/modules/Services.sys.mjs").Services;
                    return {
                      policyStatus: S.policies.status,
                      teleLocked: S.prefs.prefIsLocked(
                        "datareporting.healthreport.uploadEnabled"),
                      teleValue: S.prefs.getBoolPref(
                        "datareporting.healthreport.uploadEnabled"),
                      normandy: S.prefs.getBoolPref("app.normandy.enabled"),
                      normandyLocked: S.prefs.prefIsLocked("app.normandy.enabled"),
                      shield: S.prefs.getBoolPref(
                        "app.shield.optoutstudies.enabled"),
                      shieldLocked: S.prefs.prefIsLocked(
                        "app.shield.optoutstudies.enabled"),
                    };""",
                "args": [],
            })
            print("observed:", json.dumps(res, indent=1))
            checks = [
                ("policies.status == ACTIVE(1)", res.get("policyStatus") == 1),
                ("healthreport.uploadEnabled locked", res.get("teleLocked") is True),
                ("healthreport.uploadEnabled == false", res.get("teleValue") is False),
                ("app.normandy.enabled == false", res.get("normandy") is False),
                ("app.normandy.enabled locked (mozilla.cfg)", res.get("normandyLocked") is True),
                ("app.shield.optoutstudies.enabled == false", res.get("shield") is False),
                ("app.shield.optoutstudies.enabled locked (mozilla.cfg)", res.get("shieldLocked") is True),
            ]
            failed = [name for name, ok in checks if not ok]
            for name, ok in checks:
                print(("PASS " if ok else "FAIL ") + name)
            if failed:
                print(f"P1-T06 contract: FAIL ({len(failed)} checks)")
                return 1
            print("P1-T06 contract: PASS")
            return 0
        finally:
            wd("DELETE", f"/session/{session}")
    finally:
        gd.terminate()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
