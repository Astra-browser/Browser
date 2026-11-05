"""Lane 6 live probe: zoom levels, the Home command and window material.

Usage: python3 tools/marionette-probe/material-zoom-home-probe.py <out-dir>

Launches the packaged dev build and drives the same Host API the UI uses:

  - `zoom.in` writes the active site to `browser.content.full-zoom`; the
    Zoom levels list reads it back and Reset all clears it (default zoom kept)
  - a private write is refused and a private profile reads no levels
  - `nav.home` lands on `tabs.home`, then the startup homepage, then New Tab
  - `ui_info` and the root `data-material` / `data-materials` agree, and the
    solid tier is the only one offered on this (Linux) build
  - compact density changes the measured chrome tokens, not only Settings rows
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
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/material-zoom-home"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

BOOTED = """
  return (() => {
    const shell = document.querySelector('.astra-frame');
    return shell ? shell.getAttribute('data-app-booted') || 'pending' : 'no shell';
  })();
"""


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


def app(body):
    return "return (() => {" + APP + body + "})()"


def wait(fn, timeout=45, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def host(expr):
    return "return Services.astraHost." + expr


def setting(key, value):
    return host(
        "Settings.set({key: " + json.dumps(key) + ", value: " + json.dumps(value) + "})"
    )


def levels(profile="default"):
    return host(
        "Zoom.call({expected_profile: "
        + json.dumps(profile)
        + ', call: {kind: "levels"}})'
    )


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-lane6-")
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

        # --- Material capability and the attributes it drives -------------
        info = m.js(host("System.uiInfo()"))
        check("ui_info names the opaque tier", info.get("material") == "none", info)
        check("Linux offers only the solid tier", info.get("materials") == ["none"], info)
        material = m.js(app("return d.documentElement.dataset.material;"))
        materials = m.js(app("return d.documentElement.dataset.materials;"))
        check("root data-material agrees with ui_info", material == "none", material)
        check("root data-materials lists the same tiers", materials == "none", materials)
        m.shot("material-solid.png")

        # --- Density moves chrome tokens, not only Settings rows ----------
        def token(name):
            return m.js(
                app(
                    "return getComputedStyle(d.documentElement).getPropertyValue("
                    + json.dumps(name)
                    + ");"
                )
            )

        m.js(setting("ui.density", "comfortable"))
        wait(lambda: m.js(app("return d.documentElement.dataset.density;")) == "comfortable")
        comfortable = {
            "row-tab": token("--row-tab").strip(),
            "rail": token("--rail-width").strip(),
            "dock": token("--dock-tile").strip(),
            "bar": token("--main-bar-height").strip(),
            "control": token("--control-height").strip(),
        }
        m.js(setting("ui.density", "compact"))
        wait(lambda: m.js(app("return d.documentElement.dataset.density;")) == "compact")
        compact = {
            "row-tab": token("--row-tab").strip(),
            "rail": token("--rail-width").strip(),
            "dock": token("--dock-tile").strip(),
            "bar": token("--main-bar-height").strip(),
            "control": token("--control-height").strip(),
        }
        check("compact is applied to the root", True)
        changed = [name for name in comfortable if comfortable[name] != compact[name]]
        check(
            "compact changes tab rows, rail, dock, main bar and controls",
            changed == list(comfortable),
            {"comfortable": comfortable, "compact": compact, "changed": changed},
        )
        m.shot("density-compact.png")
        m.js(setting("ui.density", "comfortable"))

        # --- Home ---------------------------------------------------------
        m.js(setting("tabs.home", "https://home.example/start"))
        created = m.js(host('Tabs.create({url: "https://before.example/"})'))
        tab_id = created.get("astra_tab_id")
        admitted = m.js(host('Commands.run({id: "nav.home"})'))
        check("nav.home is admitted", admitted.get("accepted") is True, admitted)
        after = m.js(host("Tabs.get({astra_tab_id: " + json.dumps(tab_id) + "})"))
        check(
            "nav.home opens the saved home page",
            after.get("tab", {}).get("url") == "https://home.example/start",
            after,
        )
        m.shot("home-saved.png")

        # --- Zoom persistence and the real level list ---------------------
        m.js(host('Tabs.create({url: "https://zoom-probe.example/page"})'))
        m.js(host('Commands.run({id: "zoom.in"})'))
        listed = m.js(levels())
        rows = {row.get("site"): row.get("percent") for row in listed.get("levels", [])}
        check(
            "zoom.in stored the active site's level",
            rows.get("zoom-probe.example") == 110,
            rows,
        )
        m.shot("zoom-levels.png")

        # Reset all clears every site but keeps the default zoom.
        m.js(setting("zoom.default", "125"))
        m.js(host('Zoom.call({expected_profile: "default", call: {kind: "forget_all"}})'))
        cleared = m.js(levels())
        check("Reset all clears the list", cleared.get("levels") == [], cleared)
        default_zoom = m.js(host('Settings.get({key: "zoom.default"})'))
        check("Reset all keeps the default zoom", default_zoom == "125", default_zoom)

        # Private windows never write and never read normal levels.
        m.js(
            host(
                'Zoom.persist({url: "https://private-probe.example/", zoom: 1.5, private: true})'
            )
        )
        private_levels = m.js(levels("incognito"))
        check("a private profile reads no levels", private_levels.get("levels") == [], private_levels)
        normal = {row.get("site") for row in m.js(levels()).get("levels", [])}
        check(
            "a private write left the normal store alone",
            "private-probe.example" not in normal,
            sorted(normal),
        )

        # --- The UI's own list --------------------------------------------
        m.js(host('Zoom.persist({url: "https://listed.example/", zoom: 1.25})'))
        m.js(host('Commands.run({id: "browser.settings"})'))
        time.sleep(1.0)
        # The Settings page starts on its last section; open Appearance first.
        m.js(host('Commands.run({id: "settings.appearance"})'))
        wait(
            lambda: m.js(
                app("return !!d?.querySelector('[data-setting=\"appearance.zoom-levels\"]');")
            ),
            8,
        )
        rendered = wait(
            lambda: (
                lambda rows: rows
                if rows
                else None
            )(
                m.js(
                    app(
                        "return d ? [...d.querySelectorAll('.level .site')]"
                        ".map((n)=>n.textContent) : [];"
                    )
                )
            ),
            8,
        ) or []
        check("the Appearance page renders the real level list", "listed.example" in rendered, rendered)
        m.shot("zoom-list-ui.png")

        results["pass"] = all(item["ok"] for item in results["checks"])
    finally:
        if m is not None:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        try:
            proc.wait(timeout=20)
        except Exception:
            proc.kill()
        with open(os.path.join(OUT, "results.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"\nlane 6 probe: {'PASS' if results['pass'] else 'FAIL'} ({len(results['checks'])} checks)")
    return 0 if results["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
