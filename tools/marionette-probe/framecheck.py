"""Frame-by-frame boot check: launch one Astra window, capture every ~120ms
from the moment the window maps, and report which frames show a partial UI.

Matches the window by the launched process PID, so a stale window can never be
mistaken for this one.
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

PORT = 2838
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
FIREFOX = astra_env.BINARY
OUT = "out/headed-frames"

profile = tempfile.mkdtemp(prefix="astra-fc-")
with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
    f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
log = open(os.path.join(profile, "log"), "wb")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)

proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT)


def our_window():
    try:
        cs = json.loads(
            subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, timeout=5).stdout or b"[]"
        )
    except Exception:
        return None
    for c in cs:
        if c.get("pid") == proc.pid and c.get("class") == "firefox-default":
            return c
    return None


t0 = time.time()
shot = 0
while time.time() - t0 < 15:
    w = our_window()
    if w:
        geom = f"{w['at'][0]},{w['at'][1]} {w['size'][0]}x{w['size'][1]}"
        env = dict(os.environ, WAYLAND_DISPLAY="wayland-1")
        path = f"{OUT}/f{shot:02d}.png"
        subprocess.run(["grim", "-g", geom, path], check=False, env=env, timeout=20)
        print(f"{(time.time()-t0):5.2f}s frame={shot:02d} {w['size']}", flush=True)
        shot += 1
        if shot >= 12:
            break
    time.sleep(0.1)

print("pid", proc.pid, "leaving open", flush=True)
