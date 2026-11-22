"""Typed preference event probe: a write reaches the UI and survives a restart.

Usage: python3 tools/marionette-probe/preference-event-probe.py [out-dir]

Drives the packaged dev build with a throwaway profile:

  1. installs a listener on the window's Host API instance and records every
     `preference_changed` event and every legacy `preference.<key>=<value>`
     `ui-command` string;
  2. writes an appearance preference through the app's own `setting_set` route
     and asserts the app frame turns the new theme, exactly one typed event
     carries the key and value, and no string command was emitted;
  3. writes a feature toggle (`notes.enabled`) the same way and asserts the
     Settings switch reads off and the typed event carries the write;
  4. quits, relaunches the same profile, and asserts both choices read back,
     the theme is applied on boot, and the feature switch is still off.

Writes `preference-event.json` and screenshots beside it. Exit 0 only when
every check passes; exit 2 when the dev build is not present.
"""
import base64
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

HOST, PORT = "127.0.0.1", 2839
FIREFOX = astra_env.BINARY
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/preference-event"

APP = (
    "const f=document.querySelector('iframe[data-astra-app-frame]');"
    "const d=f&&f.contentDocument;"
)


def js(body):
    return "return (() => {" + APP + body + "})()"


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


def launch(profile):
    log = open(os.path.join(profile, "log"), "ab")
    return subprocess.Popen(
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


def install_listeners(m):
    """Record typed events and legacy strings on the window's Host instance."""
    return m.js(
        "window.__prefEvents = []; window.__prefStrings = [];"
        "const hosts = new Set();"
        "try { if (Services.astraHost) hosts.add(Services.astraHost); } catch (e) {}"
        "try { const h = Services.astraHosts && Services.astraHosts.get(window);"
        "      if (h) hosts.add(h); } catch (e) {}"
        "for (const host of hosts) {"
        "  host.addEventListener((event) => {"
        "    if (event.type === 'preference_changed' && event.data)"
        "      window.__prefEvents.push(event.data);"
        "    if (event.type === 'ui-command' && typeof event.data === 'string'"
        "        && event.data.startsWith('preference.'))"
        "      window.__prefStrings.push(event.data);"
        "  });"
        "}"
        "return hosts.size;"
    )


def invoke(m, name, args):
    """Write through the app's own route, exactly as a surface does."""
    return m.js(
        js(
            "const invoke = d?.defaultView?.__astraInvoke;"
            "if (!invoke) return { error: 'no app invoke seam' };"
            f"return invoke({json.dumps(name)}, {json.dumps(args)});"
        )
    )


def read_setting(m, key):
    return m.js("return Services.astraHost.Settings.get({key: " + json.dumps(key) + "});")


def main():
    reason = astra_env.missing_reason()
    if reason:
        print("SKIP " + reason)
        return 2
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-preference-event-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
        )

    results = {"checks": [], "pass": False}

    def check(name, ok, detail=None):
        results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- {detail}"))

    proc = phase2 = None
    try:
        proc = launch(profile)
        m = session(M(PORT))
        wait(lambda: booted(m), 90)
        time.sleep(0.8)
        hosts = install_listeners(m)
        check("the window's Host API instance is reachable", hosts and hosts >= 1, hosts)

        current = m.js(js("return d?.documentElement?.dataset?.theme || null;"))
        wanted = "light" if current == "dark" else "dark"
        written = invoke(m, "setting_set", {"key": "appearance.theme", "value": wanted})
        check("the appearance write is admitted", written and written.get("accepted") is True, written)
        theme = wait(
            lambda: m.js(js("return d?.documentElement?.dataset?.theme;")) == wanted and wanted,
            10,
        )
        check(f"the app frame turns {wanted} from the typed event", theme == wanted, theme)
        events = wait(
            lambda: [
                e
                for e in (m.js("return window.__prefEvents;") or [])
                if e.get("key") == "appearance.theme"
            ],
            10,
        )
        check(
            "exactly one typed event carries the appearance write",
            events and len(events) == 1 and events[0].get("value") == wanted,
            events,
        )
        strings = m.js("return window.__prefStrings;") or []
        check("no legacy preference string was emitted", strings == [], strings)
        m.shot("appearance.png")

        before = read_setting(m, "notes.enabled")
        toggle = invoke(m, "setting_set", {"key": "notes.enabled", "value": "false"})
        check("the feature write is admitted", toggle and toggle.get("accepted") is True, toggle)
        m.js("return Services.astraHost.Commands.run({id:'settings.features'});")
        row = wait(
            lambda: m.js(js("return d?.querySelector('[data-setting=\"notes.enabled\"]')?.dataset?.on;"))
            == "false"
            and m.js(js("return d?.querySelector('[data-setting=\"notes.enabled\"]')?.dataset?.on;")),
            15,
        )
        check("the Settings Features switch reads off", row == "false", (before, row))
        feature_events = [
            e
            for e in (m.js("return window.__prefEvents;") or [])
            if e.get("key") == "notes.enabled"
        ]
        check(
            "the feature write arrives as one typed event",
            len(feature_events) == 1 and feature_events[0].get("value") == "false",
            feature_events,
        )
        strings = m.js("return window.__prefStrings;") or []
        check("still no legacy preference string", strings == [], strings)
        m.shot("features.png")

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

        # --- the same profile, a fresh process ---------------------------
        phase2 = launch(profile)
        m2 = session(M(PORT))
        wait(lambda: booted(m2), 90)
        time.sleep(1.5)
        check(
            "the appearance value survived the restart",
            read_setting(m2, "appearance.theme") == wanted,
            read_setting(m2, "appearance.theme"),
        )
        check(
            "the feature value survived the restart",
            read_setting(m2, "notes.enabled") == "false",
            read_setting(m2, "notes.enabled"),
        )
        boot_theme = wait(
            lambda: m2.js(js("return d?.documentElement?.dataset?.theme;")) == wanted and wanted,
            15,
        )
        check(f"the app frame boots {wanted}", boot_theme == wanted, boot_theme)
        m2.js("return Services.astraHost.Commands.run({id:'settings.features'});")
        off = wait(
            lambda: m2.js(js("return d?.querySelector('[data-setting=\"notes.enabled\"]')?.dataset?.on;"))
            == "false"
            and "false",
            15,
        )
        check("the feature switch is still off after the restart", off == "false", off)
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
        with open(os.path.join(OUT, "preference-event.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        passed = sum(1 for c in results["checks"] if c["ok"])
        print(json.dumps({"pass": results["pass"], "checks": passed,
                          "total": len(results["checks"])}, indent=2))
    return 0 if results["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
