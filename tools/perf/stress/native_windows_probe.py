#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live probe: Windows API opens, focuses, fullscreens and closes real windows.

Run on the private compositor so no window appears on the owner's desktop:
  tools/perf/hidden-display.sh python3 tools/perf/stress/native_windows_probe.py
"""
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
PORT = int(os.environ.get("ASTRA_WINDOWS_PORT", "2851"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

APP_READY = """return JSON.stringify((() => {
  try {
    return {
      host: !!window.__astraHost,
      frame: !!document.querySelector('iframe[data-astra-app-frame]'),
      rootKids: document.querySelector('iframe[data-astra-app-frame]')?.contentDocument?.querySelector('#root')?.children.length ?? 0,
    };
  } catch (e) { return { error: String(e) }; }
})())"""

LIST = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.list({request_id:'p'}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

CREATE = """const priv = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.create({request_id:'p', private:priv}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

FRAME = """const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Frame.dispatchWindowControl({action:'toggle-fullscreen'}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

FOCUS = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.focus({request_id:'p', window_id:id}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

FULL = """const id = arguments[0], on = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.setFullscreen({request_id:'p', window_id:id, fullscreen:on}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

CLOSE = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => { try { done(JSON.stringify(await window.__astraHost.Windows.close({request_id:'p', window_id:id}))); }
catch (e) { done(JSON.stringify({error:String(e)})); } })();"""

NATIVE = """return JSON.stringify((() => {
  const out = [];
  try {
    const e = Services.wm.getEnumerator("navigator:browser");
    while (e.hasMoreElements()) {
      const w = e.getNext();
      if (w.closed) continue;
      let priv = false;
      try { priv = w.PrivateBrowsingUtils?.isWindowPrivate?.(w) === true; } catch (e) {}
      out.push({ private: priv, fullscreen: w.fullScreen === true, focused: Services.focus.activeWindow === w, size: [w.innerWidth, w.innerHeight], state: w.windowState });
    }
  } catch (e) { return { error: String(e) }; }
  return out;
})())"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-native-windows-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
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
                ready = json.loads(m.execute(APP_READY))
                if ready.get("host") and ready.get("frame") and (ready.get("rootKids") or 0) > 0:
                    out["ready"] = ready
                    break
            except Exception:
                pass
            time.sleep(0.1)
        out["initial"] = json.loads(m.execute_async(LIST))
        out["native_initial"] = json.loads(m.execute(NATIVE))
        out["frame_full"] = json.loads(m.execute_async(FRAME))
        time.sleep(0.4)
        out["native_frame_full"] = json.loads(m.execute(NATIVE))
        out["frame_restore"] = json.loads(m.execute_async(FRAME))
        time.sleep(0.4)
        out["native_frame_restore"] = json.loads(m.execute(NATIVE))

        made = json.loads(m.execute_async(CREATE, [False]))
        out["create"] = made
        time.sleep(1.2)
        out["after_create"] = json.loads(m.execute_async(LIST))
        out["native_after_create"] = json.loads(m.execute(NATIVE))
        nid = made.get("window_id")

        if nid:
            out["focus_old"] = json.loads(m.execute_async(FOCUS, ["win-1"]))
            time.sleep(0.4)
            out["native_after_focus_old"] = json.loads(m.execute(NATIVE))
            out["focus"] = json.loads(m.execute_async(FOCUS, [nid]))
            time.sleep(0.4)
            out["native_after_focus"] = json.loads(m.execute(NATIVE))
            out["direct_full"] = json.loads(m.execute_async(FULL, [nid, True]))
            time.sleep(0.4)
            out["after_direct_full"] = json.loads(m.execute_async(LIST))
            out["native_after_direct_full"] = json.loads(m.execute(NATIVE))
            out["direct_restore"] = json.loads(m.execute_async(FULL, [nid, False]))
            time.sleep(0.3)
            out["close"] = json.loads(m.execute_async(CLOSE, [nid]))
            time.sleep(1.0)
            out["after_close"] = json.loads(m.execute_async(LIST))
            out["native_after_close"] = json.loads(m.execute(NATIVE))

        priv = json.loads(m.execute_async(CREATE, [True]))
        out["private_create"] = priv
        time.sleep(1.0)
        out["native_after_private"] = json.loads(m.execute(NATIVE))
        if priv.get("window_id"):
            out["private_close"] = json.loads(m.execute_async(CLOSE, [priv["window_id"]]))
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
        len(out.get("initial", {}).get("windows") or []) == 1
        and len(out.get("after_create", {}).get("windows") or []) == 2
        and len(out.get("native_after_create") or []) == 2
        and out.get("focus_old", {}).get("focused") is True
        and out.get("focus", {}).get("focused") is True
        and sum(1 for w in out.get("native_after_focus") or [] if w.get("focused")) == 1
        and out.get("direct_full", {}).get("fullscreen") is True
        and next(
            (w.get("fullscreen") for w in (out.get("after_direct_full", {}).get("windows") or []) if w.get("window_id") == "win-2"),
            None,
        ) is True
        and any(w.get("fullscreen") for w in out.get("native_frame_full") or [])
        and not any(w.get("fullscreen") for w in out.get("native_frame_restore") or [])
        and out.get("close", {}).get("closed") is True
        and len(out.get("after_close", {}).get("windows") or []) == 1
        and len(out.get("native_after_close") or []) == 1
        and out.get("private_create", {}).get("private") is True
        and any(w.get("private") for w in out.get("native_after_private") or [])
        and out.get("private_close", {}).get("closed") is True
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
