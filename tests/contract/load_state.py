#!/usr/bin/env python3
"""Contract test: a local page clears `loading` immediately, not after 15 s.

Launches the built Astra binary, navigates the selected tab to a loopback
fixture, and polls the Host API projection. The bug this pins: `Content.watch`
used to wait for a 200 ms poll to observe `isLoadingDocument = true`; a fast
local load finished before the poll, so the model stayed `loading` until the
15 s `startDeadline` and the shell kept the skeleton over the page.

It also pins the second half of the same surface: the cover ends at the
**commit**, not at the end of the load. A page that commits and then keeps
fetching one slow image must show its content while `isLoadingDocument` is
still true (the row spinner carries the rest of the load).

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

# A committed document whose last subresource is still arriving. The stage's
# cover must end at the commit, not at load end, or a page with one slow ad
# image stays invisible for seconds after it is already painting.
PAGE_WITH_SLOW_ASSET = b"""<!doctype html><html><head><title>Load State Fixture</title></head>
<body><h1 id="marker">LOAD-STATE-OK</h1><img src="/asset-slow" width="8" height="8" alt=""></body></html>"""

# 1x1 transparent PNG.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63fccfc0500f000485018084a98c21"
    "0000000049454e44ae426082"
)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/slow":
            time.sleep(0.6)
        if self.path == "/asset-slow":
            time.sleep(2.0)
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("content-length", str(len(PNG)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(PNG)
            return
        body = PAGE_WITH_SLOW_ASSET if self.path == "/page-asset.html" else PAGE
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

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
  // The stage's page is the engine's own selected browser, docked over the
  // content slot by `Content.mountNative` (the slot holds no browser of its
  // own). Fall back to a slot browser for the pre-deck layout.
  const slot = document.querySelector('[data-astra-content]');
  const root = document.documentElement;
  let b = null;
  try { b = gBrowser.selectedBrowser; } catch (e) { b = null; }
  if (!b) b = document.querySelector('[data-astra-content] browser[data-astra-browser]');
  const style = b ? getComputedStyle(b) : null;
  const tabbox = document.getElementById('tabbrowser-tabbox');
  const tabboxStyle = tabbox ? getComputedStyle(tabbox) : null;
  return {
    loadingAttr: slot ? slot.getAttribute('data-loading') : null,
    hasPage: slot ? slot.getAttribute('data-has-page') : null,
    stage: root.getAttribute('data-astra-stage'),
    uri: b && b.currentURI ? b.currentURI.spec : null,
    title: b && typeof b.contentTitle === 'string' ? b.contentTitle : null,
    opacity: style ? style.opacity : null,
    tabboxVisibility: tabboxStyle ? tabboxStyle.visibility : null,
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

CREATE = """const url = arguments[0];
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.create({ request_id: 'load-state', url });
    done(JSON.stringify(r));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""


def wait_title(m, expected, timeout, last=None):
    """Poll until the page's title reaches the model, or the budget runs out."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        last = json.loads(m.execute(STATE))
        if last.get("title") == expected:
            return last
        time.sleep(0.02)
    return last or {}


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
                if m.execute(
                    "return !!window.__astraHost && document.querySelector('[data-astra-frame]')"
                    "?.getAttribute('data-app-booted') === 'true'"
                ):
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
        if not state or str(state.get("uri") or "").startswith("about:") or not state.get("uri"):
            failures.append("navigation did not commit")
        if state and state.get("title") != "Load State Fixture":
            state = wait_title(m, "Load State Fixture", 2.0, state)
            if state.get("title") != "Load State Fixture":
                failures.append(f"title={state.get('title')!r}")
        if elapsed >= 700:
            failures.append(f"loading stayed on for {elapsed:.0f} ms (budget 700 ms)")
        if state and state.get("loadingAttr") is not None:
            failures.append("content stage kept data-loading")
        if state and state.get("opacity") == "0":
            failures.append("content browser stayed at opacity:0")
        if state and state.get("isLoadingDocument") is True:
            failures.append("webProgress still reports loading")
        if state and state.get("stage") != "page":
            failures.append(f"stage={state.get('stage')!r} after the page committed")
        if state and state.get("tabboxVisibility") == "hidden":
            failures.append("native deck stayed hidden after the page committed")

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
        # The title comes from the native tab's label, which can land a beat
        # after the commit: the reveal must not wait for it, the assertion does.
        if slow_done and slow_done.get("title") != "Load State Fixture":
            slow_done = wait_title(m, "Load State Fixture", 2.0, slow_done)
            if slow_done.get("title") != "Load State Fixture":
                failures.append(f"slow title={slow_done.get('title')!r}")

        # A committed document with one slow subresource: the page is in front
        # and painting, so the cover must end at the commit. Waiting for the
        # last byte (`isLoadingDocument == false`) parks a finished page behind
        # the skeleton for as long as the slowest image takes.
        m.execute_async(NAVIGATE, [f"http://127.0.0.1:{port}/page-asset.html"])
        asset_started = time.monotonic()
        asset_state = None
        while time.monotonic() - asset_started < 4.0:
            asset_state = json.loads(m.execute(STATE))
            if asset_state.get("loadingAttr") is None and str(
                asset_state.get("uri")
            ).endswith("/page-asset.html"):
                break
            time.sleep(0.02)
        asset_elapsed = (time.monotonic() - asset_started) * 1000
        print(f"asset_elapsed_ms={asset_elapsed:.1f} state={json.dumps(asset_state)}")
        if not asset_state or asset_state.get("loadingAttr") is not None:
            failures.append("committed page stayed behind the skeleton until load end")
        if asset_elapsed >= 700:
            failures.append(
                f"cover stayed over the committed page for {asset_elapsed:.0f} ms (budget 700 ms)"
            )
        if asset_state and asset_state.get("opacity") == "0":
            failures.append("committed page stayed at opacity:0 while a subresource loaded")
        if asset_state and asset_state.get("stage") != "page":
            failures.append(f"stage={asset_state.get('stage')!r} while the page was painting")
        # The tab's own load flag is still honest: the document is not done.
        if asset_state and asset_state.get("isLoadingDocument") is not True:
            failures.append("fixture did not keep the document loading (probe is not pinning the race)")

        # A tab opened straight on an address (a link opened in a new tab) used
        # to sit on a blank stage until the page landed: the model only knew
        # about the loads it started itself. The engine's own busy edge has to
        # raise the cover too.
        created = json.loads(m.execute_async(CREATE, [f"http://127.0.0.1:{port}/slow"]))
        if "error" in created:
            failures.append(f"create: {created['error']}")
        time.sleep(0.12)
        create_early = json.loads(m.execute(STATE))
        print(f"create_early={json.dumps(create_early)}")
        if create_early.get("loadingAttr") is None:
            failures.append("a tab opened on an address showed no loading state")
        if create_early.get("stage") not in ("loading", "page"):
            failures.append(f"create stage={create_early.get('stage')!r}")
        create_started = time.monotonic()
        create_done = None
        while time.monotonic() - create_started < 4.0:
            create_done = json.loads(m.execute(STATE))
            if create_done.get("loadingAttr") is None and str(
                create_done.get("uri")
            ).endswith("/slow"):
                break
            time.sleep(0.02)
        create_elapsed = (time.monotonic() - create_started) * 1000
        print(f"create_elapsed_ms={create_elapsed:.1f} state={json.dumps(create_done)}")
        if not create_done or create_done.get("loadingAttr") is not None:
            failures.append("a tab opened on an address never revealed its page")
        if create_elapsed >= 900:
            failures.append(f"created tab revealed late ({create_elapsed:.0f} ms)")
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
