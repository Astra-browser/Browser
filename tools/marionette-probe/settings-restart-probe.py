"""Settings restart probe: set browser settings, quit, relaunch the same
profile, and verify they survived and that a startup setting actually ran.

Usage: python3 tools/marionette-probe/settings-restart-probe.py [out-dir]

Phase 1 sets a mix of native-bound and Astra-only browser settings, points
startup at a loopback page, then quits. Phase 2 launches the same profile and
checks:

  - every setting reads back the value that was written
  - the native prefs and the `astra.settings.*` branch hold those values
  - the app applied density and reduced motion on boot
  - the loopback startup page was opened by the engine
"""
import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

HOST, PORT = "127.0.0.1", 2838
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/settings-restart"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


class Page(http.server.BaseHTTPRequestHandler):
    body = b"<!doctype html><meta charset=utf-8><title>Astra restart fixture</title><p>restart</p>"

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *_args):
        pass


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("marionette did not open")
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
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def shot(self, name):
        png = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(png))


def launch(profile, blank=True):
    log = open(os.path.join(profile, "log"), "ab")
    args = [
        FIREFOX,
        "-profile",
        profile,
        "-no-remote",
        "-remote-allow-system-access",
        "--marionette",
    ]
    if blank:
        args.append("about:blank")
    return subprocess.Popen(
        args,
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )


def session(m):
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 900})
    return m


def booted(m):
    return m.js(
        js(
            "return document.querySelector('.astra-frame')"
            "?.getAttribute('data-app-booted') === 'true';"
        )
    )


def wait(fn, timeout=60, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:
            last = None
        time.sleep(step)
    return last


def read_setting(m, key):
    return m.js("return Services.astraHost.Settings.get({key: " + json.dumps(key) + "});")


def write_setting(m, key, value):
    return m.js(
        "return Services.astraHost.Settings.set({key: "
        + json.dumps(key)
        + ", value: "
        + json.dumps(value)
        + "});"
    )


SETTINGS = {
    "ui.density": "compact",
    "ui.reduce-motion": "true",
    "ntp.clock": "false",
    "tabs.switch-to-open": "false",
    "focus.breaks": "true",
    "performance.memory": "save-memory",
    "performance.after": "30",
    "search.suggestions": "false",
    "search.history": "false",
    "tabs.automatic-pip": "true",
    "tabs.new-position": "after-current",
    "privacy.camera": "Block",
    "zoom.default": "125",
}

ASTRA = {
    "astra.settings.ntp.clock": "false",
    "astra.settings.tabs.switch-to-open": "false",
    "astra.settings.focus.breaks": "true",
    "astra.settings.performance.memory": "save-memory",
}


def main():
    os.makedirs(OUT, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    start_url = f"http://127.0.0.1:{server.server_address[1]}/start.html"
    profile = tempfile.mkdtemp(prefix="astra-restart-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')

    results = {"checks": [], "pass": False}

    def check(name, ok, detail=None):
        results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- {detail}"))

    proc = None
    phase2 = None
    try:
        # --- phase 1: write, then quit -----------------------------------
        proc = launch(profile)
        m = session(M(PORT))
        wait(lambda: booted(m), 90)
        time.sleep(0.8)
        for key, value in SETTINGS.items():
            admitted = write_setting(m, key, value)
            check(f"set {key}", isinstance(admitted, dict) and admitted.get("accepted") is True,
                  admitted)
        admitted = write_setting(m, "tabs.startup-pages", start_url)
        check("set startup pages", isinstance(admitted, dict) and admitted.get("accepted") is True,
              admitted)
        admitted = write_setting(m, "tabs.startup", "pages")
        check("set startup mode", isinstance(admitted, dict) and admitted.get("accepted") is True,
              admitted)
        check("startup page is the native homepage",
              m.js("return Services.prefs.getStringPref('browser.startup.homepage');") == start_url)
        print("after set startup.page", m.js("return Services.prefs.getIntPref('browser.startup.page');"), flush=True)
        m.shot("before-restart.png")
        time.sleep(0.5)
        # Flush user prefs, then quit through the app so shutdown is clean.
        try:
            m.js("Services.prefs.savePrefFile(null); return true;")
            m.js("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return true;")
        except Exception:
            pass
        try:
            proc.wait(timeout=30)
        except Exception:
            proc.terminate()
        time.sleep(2.0)

        # --- phase 2: relaunch the same profile --------------------------
        phase2 = launch(profile, blank=False)
        m2 = session(M(PORT))
        wait(lambda: booted(m2), 90)
        time.sleep(1.5)
        for key, value in SETTINGS.items():
            actual = read_setting(m2, key)
            check(f"after restart {key}", actual == value, actual)
        actual_pages = read_setting(m2, "tabs.startup-pages")
        check("after restart startup pages", actual_pages == start_url, actual_pages)
        actual_mode = read_setting(m2, "tabs.startup")
        check("after restart startup mode", actual_mode == "pages", actual_mode)

        native = {
            "browser.uidensity": ("Int", 1),
            "ui.prefersReducedMotion": ("Int", 1),
            "browser.search.suggest.enabled": ("Bool", False),
            "browser.urlbar.suggest.history": ("Bool", False),
            "browser.tabs.insertAfterCurrent": ("Bool", True),
            "browser.tabs.min_inactive_duration_before_unload": ("Int", 1800000),
            "permissions.default.camera": ("Int", 2),
            "browser.startup.page": ("Int", 1),
            "browser.startup.homepage": ("String", start_url),
        }
        for name, (kind, expected) in native.items():
            actual = m2.js(f"return Services.prefs.get{kind}Pref({json.dumps(name)});")
            check(f"native {name}", actual == expected, actual)
        auto_pip = m2.js(
            "return Services.prefs.getBoolPref("
            "'media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled');"
        )
        check("native automatic picture-in-picture", auto_pip is True, auto_pip)

        for name, expected in ASTRA.items():
            actual = m2.js(f"return Services.prefs.getStringPref({json.dumps(name)}, null);")
            check(f"profile {name}", actual == expected, actual)

        density = wait(
            lambda: m2.js(js("return d?.documentElement?.dataset?.density;")) == "compact"
            and "compact",
            10,
        )
        check("applied compact density after restart", density == "compact", density)
        motion = wait(
            lambda: m2.js(js("return d?.documentElement?.dataset?.reduceMotion;")) == "true"
            and "true",
            10,
        )
        check("applied reduced motion after restart", motion == "true", motion)

        zoom = m2.js(
            "return new Promise((done) => {"
            "const cps = Cc['@mozilla.org/content-pref/service;1']"
            ".getService(Ci.nsIContentPrefService2);"
            "cps.getGlobal('browser.content.full-zoom', Cu.createLoadContext(), {"
            "handleResult(p) { done(p.value); },"
            "handleCompletion() {},"
            "handleError() { done(null); }"
            "});"
            "});"
        )
        check("default zoom survived", zoom and abs(float(zoom) - 1.25) < 0.001, zoom)

        tabs = m2.js(
            "return Services.astraHost.Tabs.list({request_id:'restart-list'})"
            ".then((r) => JSON.stringify((r.tabs || []).map((t) => t.url)));"
        )
        urls = json.loads(tabs or "[]")
        check("the startup page opened after restart", start_url in urls, urls)
        m2.shot("after-restart.png")
        results["pass"] = all(c["ok"] for c in results["checks"])
    finally:
        for p in (phase2, proc):
            try:
                if p and p.poll() is None:
                    p.terminate()
                    p.wait(timeout=10)
            except Exception:
                pass
        server.shutdown()
        with open(os.path.join(OUT, "restart.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(json.dumps({"pass": results["pass"], "checks": len(results["checks"])}, indent=2))
    return 0 if results["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
