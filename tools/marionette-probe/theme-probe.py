"""Theme probe: the chrome's light/dark choice and a real page's view of it.

Usage: python3 tools/marionette-probe/theme-probe.py <out-dir>

Launches the packaged dev build, reads the chrome theme and the content
`prefers-color-scheme` pref, opens a real HTTP page that reports its own
`matchMedia('(prefers-color-scheme: dark)')` in the title, switches the
browser to dark, and checks the page follows without a reload. It also
captures the dark and light chrome for visual review.
"""
import base64
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

HOST, PORT = "127.0.0.1", 2831
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/theme-probe"
PREF = "layout.css.prefers-color-scheme.content-override"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


BOOTED = """
  return (() => {
    const shell = document.querySelector('.astra-frame');
    return shell ? shell.getAttribute('data-app-booted') || 'pending' : 'no shell';
  })();
"""

THEME = js("return d ? d.documentElement.getAttribute('data-theme') : null;")
PREF_VALUE = f"return Services.prefs.getIntPref('{PREF}');"


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

    def nudge(self, width, height):
        self.cmd("WebDriver:SetWindowRect", {"width": width + 1, "height": height + 1})
        time.sleep(0.25)
        self.cmd("WebDriver:SetWindowRect", {"width": width, "height": height})
        time.sleep(0.6)


class Page(http.server.BaseHTTPRequestHandler):
    body = b"""<!doctype html>
<meta charset="utf-8">
<title>init</title>
<script>
  const set = () => {
    document.title = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  set();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', set);
</script>
<p>theme probe</p>
"""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *_args):
        pass


def wait(fn, timeout=60, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def main():
    os.makedirs(OUT, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    page_url = f"http://127.0.0.1:{server.server_address[1]}/scheme.html"

    profile = tempfile.mkdtemp(prefix="astra-theme-")
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
    results = {"page": page_url, "checks": []}
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1200, "height": 820})
        wait(lambda: m.js(BOOTED) == "true", 90)
        time.sleep(1.5)
        results["initial-theme"] = m.js(THEME)
        results["initial-pref"] = m.js(PREF_VALUE)

        # A real page reports what it sees through matchMedia.
        created = m.js(
            "return Services.astraHost.Tabs.create({"
            f'request_id: "theme-probe-page", url: {json.dumps(page_url)}'
            "});"
        )
        results["created"] = created

        def title():
            shown = m.js(
                "return Services.astraHost.Tabs.list({request_id: 'theme-probe-list'})"
                ".then((r) => JSON.stringify((r.tabs || []).map((t) => ({"
                "title: t.title, url: t.url, selected: t.selected"
                "}))));"
            )
            rows = json.loads(shown) if shown else []
            for row in rows:
                if row.get("url") == page_url:
                    return row.get("title")
            return None

        results["page-title-light"] = wait(lambda: title() == "light" and "light", 30)

        def tab_ids():
            shown = m.js(
                "return Services.astraHost.Tabs.list({request_id: 'theme-probe-ids'})"
                ".then((r) => JSON.stringify((r.tabs || []).map((t) => ({"
                "id: t.astra_tab_id, url: t.url"
                "}))));"
            )
            return json.loads(shown) if shown else []

        page_id = (created or {}).get("astra_tab_id") if isinstance(created, dict) else None
        new_id = next((t["id"] for t in tab_ids() if t["id"] != page_id), None)

        def select(tab_id):
            if not tab_id:
                return
            m.js(
                "return Services.astraHost.Tabs.select({"
                f'request_id: "theme-probe-select", astra_tab_id: {json.dumps(tab_id)}'
                "});"
            )
            time.sleep(0.8)

        # Dark: the chrome, the pref and the page must all follow.
        m.js("return Services.astraHost.Commands.run({ id: 'theme.dark' });")
        dark_theme = wait(lambda: m.js(THEME) == "dark" and "dark", 20)
        dark_pref = wait(lambda: m.js(PREF_VALUE) == 0 and 0, 20)
        dark_title = wait(lambda: title() == "dark" and "dark", 20)
        results["dark-theme"] = dark_theme
        results["dark-pref"] = dark_pref
        results["page-title-dark"] = dark_title
        m.nudge(1200, 820)
        m.shot("dark-shell.png")
        m.shot("dark-page.png")

        # The new tab, the surface a person rests on, in the same dark card.
        select(new_id)
        m.nudge(1200, 820)
        m.shot("dark-newtab.png")

        # Light: back to the paper chrome, with the page in front so its own
        # title proves it followed the change.
        select(page_id)
        m.js("return Services.astraHost.Commands.run({ id: 'theme.light' });")
        results["light-theme"] = wait(lambda: m.js(THEME) == "light" and "light", 20)
        results["light-pref"] = wait(lambda: m.js(PREF_VALUE) == 1 and 1, 20)
        results["page-title-light-again"] = wait(lambda: title() == "light" and "light", 20)
        m.nudge(1200, 820)
        m.shot("light-shell.png")

        select(new_id)
        m.nudge(1200, 820)
        m.shot("light-newtab.png")

        results["pass"] = all(
            [
                results.get("initial-theme") == "light",
                results.get("initial-pref") == 1,
                results.get("page-title-light") == "light",
                results.get("dark-theme") == "dark",
                results.get("dark-pref") == 0,
                results.get("page-title-dark") == "dark",
                results.get("light-theme") == "light",
                results.get("light-pref") == 1,
                results.get("page-title-light-again") == "light",
            ]
        )
    finally:
        if m is not None:
            try:
                m.cmd("WebDriver:Quit", {})
            except Exception:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        server.shutdown()

    print(json.dumps(results, indent=2))
    if not results.get("pass"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
