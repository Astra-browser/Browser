"""Wiring probe: click Work in the packaged chrome and prove the surface moved.

Launches the dev build with a throwaway profile, drives the real UI over
Marionette (chrome context, same principal as the app iframe), and reports
what the app document shows after the click. Stdlib only.

Usage: python3 tools/marionette-probe/wiring-page-nav.py <profile-dir> <out-dir>
"""
import base64
import json
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from marionette import Marionette  # noqa: E402

HOST, PORT = "127.0.0.1", 2828
FIREFOX = astra_env.BINARY

CLICK_WORK = """return JSON.stringify((() => {
  const frame = document.querySelector('iframe[data-astra-app-frame]');
  const doc = frame && frame.contentDocument;
  if (!doc) return { ok: false, why: 'no app document' };
  const radios = [...doc.querySelectorAll('[role="radio"]')];
  const work = radios.find((r) => (r.textContent || '').trim() === 'Work');
  if (!work) return { ok: false, why: 'no Work radio', radios: radios.map(r => r.textContent) };
  work.click();
  return { ok: true };
})())"""

STATE = """return JSON.stringify((() => {
  const frame = document.querySelector('iframe[data-astra-app-frame]');
  const doc = frame && frame.contentDocument;
  if (!doc) return { ok: false };
  const shell = doc.querySelector('.shell');
  const start = doc.querySelector('.start');
  return {
    ok: true,
    surface: shell ? shell.getAttribute('data-astra-surface') : null,
    startScreen: !!start,
    title: (doc.querySelector('#work-start-title') || {}).textContent || null,
    banner: (doc.querySelector('.navigation-error') || {}).textContent || null,
  };
})())"""

def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR,
        stdout=errlog, stderr=subprocess.STDOUT)

    m = None
    for _ in range(60):
        try:
            m = Marionette(PORT, host=HOST, wait=0)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-CAME-UP")
        proc.terminate()
        return 1

    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(20)

    clicked = json.loads(m.cmd("WebDriver:ExecuteScript", {"script": CLICK_WORK, "args": []})["value"])
    print("CLICK: " + json.dumps(clicked), flush=True)
    time.sleep(2)
    state = json.loads(m.cmd("WebDriver:ExecuteScript", {"script": STATE, "args": []})["value"])
    print("STATE: " + json.dumps(state), flush=True)

    try:
        shot = m.cmd("WebDriver:TakeScreenshot", {})
        with open(os.path.join(outdir, "work.png"), "wb") as f:
            f.write(base64.b64decode(shot["value"]))
        print("screenshot ok", flush=True)
    except Exception as e:
        print(f"screenshot-ERR {e}", flush=True)

    ok = clicked.get("ok") and state.get("ok") and state.get("surface") == "work" \
        and not state.get("banner")
    print("VERDICT: " + ("PASS" if ok else "FAIL"), flush=True)
    proc.terminate()
    return 0 if ok else 1

sys.exit(main())
