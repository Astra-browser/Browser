"""Settings probe: Astra settings are bound to the prefs Firefox owns.

Usage: python3 tools/marionette-probe/settings-native-probe.py <out-dir>

Launches the packaged dev build, then for every mapped browser setting writes
it through the same Host API the Settings page uses and checks:

  - the real pref (or default-zoom content pref) changed,
  - reading the setting back returns the same value,
  - the app's own UI applied the change from the `ui-command` push.

It also checks that an Astra-only setting does not create a Firefox pref.
"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HOST, PORT = "127.0.0.1", 2833
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OBJDIR = "obj-astra-windows" if os.name == "nt" else "obj-astra-linux"
BINARY = "firefox.exe" if os.name == "nt" else "firefox"
FIREFOX = os.path.abspath(os.environ.get("ASTRA_BINARY") or os.path.join(
    ROOT, "engine", OBJDIR, "dist", "bin", BINARY))
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/settings-native"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

BOOTED = """
  return (() => {
    const shell = document.querySelector('.astra-frame');
    return shell ? shell.getAttribute('data-app-booted') || 'pending' : 'no shell';
  })();
"""


def js(body):
    return "return (() => {" + APP + body + "})()"


class M:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:200]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def shot(self, name):
        png = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(png))


def wait(fn, timeout=45, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def write(key, value):
    return (
        "return Services.astraHost.Settings.set({key: "
        + json.dumps(key)
        + ", value: "
        + json.dumps(value)
        + "});"
    )


def read(key):
    return (
        "return Services.astraHost.Settings.get({key: "
        + json.dumps(key)
        + "});"
    )


def pref(kind, name):
    return f"return Services.prefs.get{kind}Pref({json.dumps(name)});"


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-settings-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [
            FIREFOX,
            "-profile",
            profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    results = {"checks": [], "pass": False}
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1200, "height": 820})
        wait(lambda: m.js(BOOTED) == "true", 90)
        time.sleep(1.0)

        def check(name, ok, detail=None):
            results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
            print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- {detail}"))

        # Defaults already come from the engine.
        check(
            "default proxy reads the native system mode",
            m.js(read("network.proxy")) == "system",
            m.js(read("network.proxy")),
        )
        check(
            "default density reads the native density",
            m.js(read("ui.density")) == "comfortable",
            m.js(read("ui.density")),
        )

        cases = [
            ("ui.density", "compact", "Int", "browser.uidensity", 1),
            ("ui.reduce-motion", "true", "Int", "ui.prefersReducedMotion", 1),
            ("tabs.automatic-pip", "true", "Bool",
             "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", True),
            ("tabs.new-position", "after-current", "Bool", "browser.tabs.insertAfterCurrent", True),
            ("tabs.external-position", "after-current", "Int",
             "browser.link.open_newwindow.override.external", 7),
            ("tabs.startup", "continue", "Int", "browser.startup.page", 3),
            ("search.suggestions", "false", "Bool", "browser.search.suggest.enabled", False),
            ("search.history", "false", "Bool", "browser.urlbar.suggest.history", False),
            ("privacy.smartscreen", "false", "Bool", "browser.safebrowsing.malware.enabled", False),
            ("privacy.cleanup", "true", "Bool", "privacy.sanitize.sanitizeOnShutdown", True),
            ("privacy.camera", "Block", "Int", "permissions.default.camera", 2),
            ("privacy.microphone", "Allow", "Int", "permissions.default.microphone", 1),
            ("privacy.location", "Block", "Int", "permissions.default.geo", 2),
            ("privacy.notifications", "Allow", "Int",
             "permissions.default.desktop-notification", 1),
            ("performance.sleep", "true", "Bool", "browser.tabs.unloadOnLowMemory", True),
            ("performance.after", "30", "Int",
             "browser.tabs.min_inactive_duration_before_unload", 1800000),
        ]
        for key, value, kind, name, expected in cases:
            admitted = m.js(write(key, value))
            actual = m.js(pref(kind, name))
            check(
                f"{key} -> {name}",
                isinstance(admitted, dict)
                and admitted.get("accepted") is True
                and actual == expected,
                {"admitted": admitted, "pref": actual, "expected": expected},
            )
            check(
                f"{key} reads back",
                m.js(read(key)) == value,
                m.js(read(key)),
            )

        # The app applies the pushed preference to its own surface.
        density = wait(lambda: m.js(js("return d?.documentElement?.dataset?.density;")) == "compact" and "compact")
        check("the app applied compact density", density == "compact", density)
        motion = wait(lambda: m.js(js("return d?.documentElement?.dataset?.reduceMotion;")) == "true" and "true")
        check("the app applied reduced motion", motion == "true", motion)
        m.shot("settings-applied.png")

        # A pref changed outside Astra is observed and pushed to the app too.
        m.js("Services.prefs.setIntPref('browser.uidensity', 0);")
        outside = wait(
            lambda: m.js(js("return d?.documentElement?.dataset?.density;")) == "comfortable"
            and "comfortable"
        )
        check("an external pref change reaches the app", outside == "comfortable", outside)

        # Lists with a newline separator reach one native pref.
        pages = "https://a.example/\nhttps://b.example/"
        admitted = m.js(write("tabs.startup-pages", pages))
        homepage = m.js(pref("String", "browser.startup.homepage"))
        check(
            "startup pages write one native homepage list",
            isinstance(admitted, dict)
            and admitted.get("accepted") is True
            and homepage == "https://a.example/|https://b.example/",
            homepage,
        )
        check("startup pages read back", m.js(read("tabs.startup-pages")) == pages,
              m.js(read("tabs.startup-pages")))

        # Proxy mode and address are native network prefs.
        check("proxy mode is admitted", m.js(write("network.proxy", "http")).get("accepted") is True)
        check(
            "proxy mode writes manual type",
            m.js(pref("Int", "network.proxy.type")) == 1,
            m.js(pref("Int", "network.proxy.type")),
        )
        check(
            "proxy address is admitted",
            m.js(write("network.proxy-address", "proxy.example:3128")).get("accepted") is True,
        )
        check(
            "proxy address writes the native host",
            m.js(pref("String", "network.proxy.http")) == "proxy.example",
            m.js(pref("String", "network.proxy.http")),
        )
        check(
            "proxy address reads back",
            m.js(read("network.proxy-address")) == "proxy.example:3128",
            m.js(read("network.proxy-address")),
        )
        m.js(write("network.proxy", "system"))

        # Default zoom lives in the content-pref service.
        check("default zoom is admitted", m.js(write("zoom.default", "125")).get("accepted") is True)
        zoom = m.js(
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
        check("default zoom writes the content pref", zoom and abs(float(zoom) - 1.25) < 0.001, zoom)
        check("default zoom reads back", m.js(read("zoom.default")) == "125",
              m.js(read("zoom.default")))

        # Astra-only settings stay Astra's. They are persisted under the
        # `astra.settings.*` namespace; no Firefox namespace may grow a pref
        # that pretends to own the key.
        check("Astra-only setting is admitted", m.js(write("ntp.clock", "false")).get("accepted") is True)
        check(
            "Astra-only setting invents no Firefox pref",
            not m.js(
                "return Services.prefs.getChildList('').some("
                "(name) => !name.startsWith('astra.') && name.includes('ntp.clock'));"
            ),
        )

        # A bad value is refused in the engine, not merely by the page.
        check(
            "an invalid proxy address is refused",
            m.js(write("network.proxy-address", "no-port")).get("accepted") is False,
        )

        results["pass"] = all(item["ok"] for item in results["checks"])
    finally:
        try:
            if m:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        time.sleep(1.0)
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass
        with open(os.path.join(OUT, "settings-native.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(json.dumps({"pass": results["pass"],
                          "checks": len(results["checks"])}, indent=2))
    return 0 if results["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
