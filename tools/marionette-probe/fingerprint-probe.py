#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live fingerprinting-protection probe (D-43).

Runs a local page in two throwaway profiles:
  * packaged defaults (FPP + native tracking protection on)
  * one user override turning FPP off (the control)

It proves the default is actually active and that FPP changes the surfaces a
page can read: canvas output differs between the profiles, the GPU model is
hidden, and hardware concurrency is tiered. No media is loaded and no sound is
produced.

Usage: python3 tools/marionette-probe/fingerprint-probe.py
Exit: 0 PASS, 1 FAIL.
"""
import hashlib
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><title>fingerprint probe</title><h1>fingerprint</h1>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c:
                raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c:
                raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            message = self._read()
            if isinstance(message, list) and len(message) == 4 and message[1] == self._id:
                if message[2]:
                    raise RuntimeError(f"{method} -> {message[2]}: {json.dumps(message[3])[:400]}")
                return message[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


SURFACES = r"""
const out = {};
out.ua = navigator.userAgent;
out.platform = navigator.platform;
out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
out.screen = [screen.width, screen.height];
out.dpr = devicePixelRatio;
out.hardwareConcurrency = navigator.hardwareConcurrency;
try {
  const c = document.createElement('canvas'); c.width = 240; c.height = 60;
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(120,40,200)'; x.fillRect(0,0,240,60);
  x.font = '18px Arial'; x.fillStyle = '#fff';
  x.fillText('Astra fingerprint probe', 8, 36);
  out.canvas = c.toDataURL();
} catch (e) { out.canvas = 'error'; }
try {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (gl) {
    out.renderer = gl.getParameter(gl.RENDERER);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) out.unmaskedRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  }
} catch (e) { out.renderer = 'error'; }
return JSON.stringify(out);
"""


def hash_canvas(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16] if isinstance(value, str) else "?"


def run(name, port, extra_prefs):
    profile = tempfile.mkdtemp(prefix=f"astra-fp-{name}-")
    lines = [f'user_pref("marionette.port", {port});']
    for key, value in extra_prefs.items():
        lines.append(f'user_pref("{key}", {json.dumps(value)});')
    with open(os.path.join(profile, "prefs.js"), "w") as handle:
        handle.write("\n".join(lines) + "\n")
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    try:
        m = M(port)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        for _ in range(60):
            if m.js("return !!Services?.astraHost;"):
                break
            time.sleep(1)
        tab = m.js("return Services.astraHost.Tabs.list({request_id:'fp'}).then(r=>r.selected_tab_id);")
        m.cmd("WebDriver:ExecuteScript", {"script": "return Services.astraHost.Navigation.loadURL({request_id:'fp', astra_tab_id:arguments[0], url:arguments[1]});", "args": [tab, URL]})
        time.sleep(4)
        m.cmd("Marionette:SetContext", {"value": "content"})
        surfaces = json.loads(m.js(SURFACES))
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        prefs = json.loads(m.js("""
          const p = Services.prefs;
          return JSON.stringify({
            fpp: p.getBoolPref('privacy.fingerprintingProtection', false),
            overrides: p.getStringPref('privacy.fingerprintingProtection.overrides', ''),
          });
        """))
        if name == "default":
            accepted = m.js(
                "return Services.astraHost.Settings.set({key:'privacy.fingerprinting', value:'false'}).then(r => r.accepted === true);"
            )
            prefs["toggle_accepted"] = accepted is True
            prefs["after_off"] = m.js(
                "return Services.prefs.getBoolPref('privacy.fingerprintingProtection', true);"
            )
            m.js("return Services.astraHost.Settings.set({key:'privacy.fingerprinting', value:'true'}).then(r => r.accepted === true);")
            prefs["after_on"] = m.js(
                "return Services.prefs.getBoolPref('privacy.fingerprintingProtection', false);"
            )
        return surfaces, prefs
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


server = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{server.server_address[1]}/"

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


try:
    default, prefs = run("default", 2931, {})
    control, control_prefs = run(
        "control",
        2932,
        {"privacy.fingerprintingProtection": False},
    )

    check("default profile has FPP on", prefs.get("fpp") is True, json.dumps(prefs))
    check("overrides load", "WebGLRenderInfo" in prefs.get("overrides", ""), prefs.get("overrides"))
    check("Settings switch turns FPP off and back on",
          prefs.get("toggle_accepted") is True
          and prefs.get("after_off") is False
          and prefs.get("after_on") is True,
          json.dumps({k: prefs.get(k) for k in ("toggle_accepted", "after_off", "after_on")}))
    check("control profile has FPP off", control_prefs.get("fpp") is False, json.dumps(control_prefs))

    default_canvas = hash_canvas(default.get("canvas"))
    control_canvas = hash_canvas(control.get("canvas"))
    check("canvas is randomized under FPP", default_canvas != control_canvas,
          f"{default_canvas} vs {control_canvas}")
    check("GPU model is hidden", default.get("unmaskedRenderer") in (None, "Mozilla", "WebGL"),
          str(default.get("unmaskedRenderer")))
    check("hardware concurrency is tiered", default.get("hardwareConcurrency") != control.get("hardwareConcurrency")
          or default.get("hardwareConcurrency") in (2, 4, 8),
          f"{default.get('hardwareConcurrency')} vs {control.get('hardwareConcurrency')}")
    check("user agent is not spoofed by FPP", default.get("ua") == control.get("ua"),
          f"{default.get('ua')} vs {control.get('ua')}")

    print("\nfingerprint: default=" + json.dumps({
        "canvas": default_canvas,
        "renderer": default.get("unmaskedRenderer"),
        "hw": default.get("hardwareConcurrency"),
        "screen": default.get("screen"),
        "dpr": default.get("dpr"),
        "tz": default.get("tz"),
    }))
    print("fingerprint: control=" + json.dumps({
        "canvas": control_canvas,
        "renderer": control.get("unmaskedRenderer"),
        "hw": control.get("hardwareConcurrency"),
        "screen": control.get("screen"),
        "dpr": control.get("dpr"),
        "tz": control.get("tz"),
    }))
finally:
    server.shutdown()

print("fingerprint probe:", "PASS" if not failures else f"FAIL ({len(failures)}: {failures})")
raise SystemExit(0 if not failures else 1)
