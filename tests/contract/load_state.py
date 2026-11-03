#!/usr/bin/env python3
"""Contract test: a local page clears `loading` immediately, not after 15 s.

Launches the built Astra binary, navigates the selected tab to a loopback
fixture, and polls the Host API projection. The bug this pins: `Content.watch`
used to wait for a 200 ms poll to observe `isLoadingDocument = true`; a fast
local load finished before the poll, so the model stayed `loading` until the
15 s `startDeadline` and the shell kept the skeleton over the page.

Run headed on a private compositor:
  tools/perf/hidden-display.sh python3 tests/contract/load_state.py

Exit 0 PASS, 1 FAIL, 2 SKIP when the binary is absent. Stdlib only.
"""
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = os.environ.get(
    "ASTRA_BINARY",
    os.path.join(ROOT, "engine", "obj-astra-linux", "dist", "bin", "firefox"),
)
PORT = int(os.environ.get("ASTRA_LOAD_STATE_PORT", "2838"))
PAGE = b"""<!doctype html><html><head><title>Load State Fixture</title></head>
<body><h1 id="marker">LOAD-STATE-OK</h1></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/slow":
            time.sleep(0.6)
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(PAGE)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass


def serve():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


class Marionette:
    def __init__(self, port, timeout=60):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
                break
            except OSError as exc:
                last = exc
                time.sleep(0.2)
        else:
            raise RuntimeError(f"marionette never came up: {last}")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            rest += self.f.read(length - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:400]}")
                return msg[3]

    def execute(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def execute_async(self, script, args=None):
        return self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})["value"]


STATE = """return JSON.stringify((() => {
  const b = document.querySelector('browser[data-astra-browser]');
  const slot = document.querySelector('[data-astra-content]');
  const style = b ? getComputedStyle(b) : null;
  return {
    loadingAttr: slot ? slot.getAttribute('data-loading') : null,
    hasPage: slot ? slot.getAttribute('data-has-page') : null,
    uri: b && b.currentURI ? b.currentURI.spec : null,
    title: b && typeof b.contentTitle === 'string' ? b.contentTitle : null,
    opacity: style ? style.opacity : null,
    isLoadingDocument: b && b.webProgress ? b.webProgress.isLoadingDocument : null,
  };
})())"""

TABS = """const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.list({ request_id: 'load-state' });
    done(JSON.stringify(r.tabs || []));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

NAVIGATE = """const url = arguments[0];
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Navigation.loadURL({ request_id: 'load-state', url });
    done(JSON.stringify(r));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""


def main():
    if not os.path.exists(FIREFOX):
        print("SKIP no built binary at " + FIREFOX)
        return 2
    server, port = serve()
    profile = tempfile.mkdtemp(prefix="astra-load-state-")
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        fh.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
    log = open(os.path.join(profile, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [
            FIREFOX,
            "-profile", profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    failures = []
    try:
        m = Marionette(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if m.execute("return !!window.__astraHost && !!document.querySelector('iframe[data-astra-app-frame]')?.contentDocument?.querySelector('#root')?.children.length"):
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("Astra app never became ready")

        navigate = json.loads(m.execute_async(NAVIGATE, [f"http://127.0.0.1:{port}/page.html"]))
        if "error" in navigate:
            failures.append(f"navigate: {navigate['error']}")
        started = time.monotonic()
        state = None
        while time.monotonic() - started < 8.0:
            tabs = json.loads(m.execute_async(TABS))
            active = next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)
            state = json.loads(m.execute(STATE))
            if active and active.get("loading") is False and state.get("loadingAttr") is None:
                break
            time.sleep(0.02)
        elapsed = (time.monotonic() - started) * 1000
        print(f"elapsed_ms={elapsed:.1f} state={json.dumps(state)}")
        if not state or state.get("uri", "").startswith("about:"):
            failures.append("navigation did not commit")
        if state and state.get("title") != "Load State Fixture":
            failures.append(f"title={state.get('title')!r}")
        if elapsed >= 700:
            failures.append(f"loading stayed on for {elapsed:.0f} ms (budget 700 ms)")
        if state and state.get("loadingAttr") is not None:
            failures.append("content stage kept data-loading")
        if state and state.get("opacity") == "0":
            failures.append("content browser stayed at opacity:0")
        if state and state.get("isLoadingDocument") is True:
            failures.append("webProgress still reports loading")

        # The opposite case: a server that waits before the first byte must
        # keep the skeleton until it actually starts, then clear normally.
        m.execute_async(NAVIGATE, [f"http://127.0.0.1:{port}/slow"])
        time.sleep(0.12)
        slow_early = json.loads(m.execute(STATE))
        if slow_early.get("loadingAttr") is None:
            failures.append("slow request did not show a loading state")
        slow_started = time.monotonic()
        slow_done = None
        while time.monotonic() - slow_started < 4.0:
            slow_done = json.loads(m.execute(STATE))
            if slow_done.get("loadingAttr") is None:
                break
            time.sleep(0.02)
        slow_ms = (time.monotonic() - slow_started) * 1000
        print(f"slow_elapsed_ms={slow_ms:.1f} state={json.dumps(slow_done)}")
        if slow_done and slow_done.get("loadingAttr") is not None:
            failures.append("slow request never cleared loading")
        if slow_done and slow_done.get("title") != "Load State Fixture":
            failures.append(f"slow title={slow_done.get('title')!r}")
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        log.close()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    if failures:
        print("load_state: FAIL " + "; ".join(failures))
        return 1
    print("load_state: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
