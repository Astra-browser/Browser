"""Tab re-assert probe: a redundant selection must still present the tab.

Reproduces the 2026-11-21 owner report: after a window sits in the background
(other apps in front) or churns through profile/space switches, clicking a tab
sometimes does nothing and only switching to another tab and back recovers it.

Two engine states are forced, both of which the host must repair when the
person selects the tab that is already the engine's selectedTab:

  1. the engine's deck shows another tab's panel while the selectedTab is the
     one the person clicked, as an interrupted switch, an occlusion and a tab
     move can leave it;
  2. the same drift after the OS activates the window, with no tab switch.

The tabbrowser treats selecting the already-selected tab as a no-op, so
without the host repair a click can never recover either state. The probe
clicks the real Astra tab row and reads the engine back.

Usage: python tools/marionette-probe/tab-reassert-probe.py [outdir]
"""
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2847
MARIONETTE_PORT = 2828
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Reassert __TAB__</title></head>
<body><h1>Reassert __TAB__</h1>
<button id="press" onclick="window.__presses=(window.__presses||0)+1">press</button>
<script>window.__presses=0;</script>
</body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.strip("/").upper()
        if name not in ("A", "B"):
            self.send_response(404)
            self.end_headers()
            return
        body = PAGE.replace("__TAB__", name).encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class M:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError
            data += chunk
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            rest += self.f.read(n - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            m = self._read()
            if isinstance(m, list) and len(m) == 4 and m[1] == self._id:
                if m[2]:
                    raise RuntimeError(m)
                return m[3]

    def js(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def js_async(self, script, args=None):
        return self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})["value"]


TABS = """const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.list({ request_id: 'reassert' });
    done(JSON.stringify(r.tabs || []));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

CREATE = """const url = arguments[0];
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.create({
      request_id: 'reassert', url, background: false,
    });
    done(JSON.stringify(r));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

# The engine's own view of the selected tab, its browser and the deck panel.
STATE = """return JSON.stringify((() => {
  const gb = window.gBrowser;
  const tab = gb.selectedTab;
  const browser = tab && tab.linkedBrowser;
  const panel = tab && gb.tabContainer.getRelatedElement(tab);
  const shown = gb.tabpanels.selectedPanel;
  let uri = null;
  try { uri = browser && browser.currentURI ? browser.currentURI.spec : null; } catch (e) {}
  return {
    uri,
    docActive: browser ? browser.docShellIsActive : null,
    panelId: panel ? panel.id : null,
    shownId: shown ? shown.id : null,
    panelMatches: !!panel && panel === shown,
    visibility: (() => { try { return browser.contentWindow.document.visibilityState; } catch (e) { return null; } })(),
  };
})())"""

DEACTIVATE = """return JSON.stringify((() => {
  const gb = window.gBrowser;
  const browser = gb.selectedTab.linkedBrowser;
  const bc = browser.browsingContext;
  browser.preserveLayers(false);
  bc.isActive = false;
  browser.docShellIsActive = false;
  return { docActive: browser.docShellIsActive, bcActive: bc.isActive };
})())"""

# Force the deck to another tab's panel without changing selectedTab.
DRIFT = """return JSON.stringify((() => {
  const gb = window.gBrowser;
  const selected = gb.selectedTab;
  const other = [...gb.tabs].find((t) => t !== selected);
  if (!other) return { error: 'only one tab' };
  const otherPanel = gb.tabContainer.getRelatedElement(other);
  gb.tabpanels.selectedPanel = otherPanel;
  return {
    selectedUri: selected.linkedBrowser.currentURI.spec,
    shownId: gb.tabpanels.selectedPanel ? gb.tabpanels.selectedPanel.id : null,
    selectedPanelId: gb.tabContainer.getRelatedElement(selected).id,
  };
})())"""

# Dispatch the window activate the OS sends when the person returns from
# another app.
ACTIVATE = """window.dispatchEvent(new window.Event('activate')); return 'ok';"""

# Click the app's real tab row for the given model id.
CLICK_ROW = """const d = document.querySelector('iframe[data-astra-app-frame]')?.contentDocument;
if (!d) return 'no app frame';
const row = d.querySelector('[data-astra-tab-id="' + arguments[0] + '"]');
if (!row) return 'no row';
const target = row.querySelector('button.tab-open') || row;
target.click();
return 'ok';"""


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "out", "probe-reassert")
    os.makedirs(outdir, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-reassert-")
    server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", profile, "-no-remote",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(os.path.abspath(FIREFOX)),
        stdout=log, stderr=subprocess.STDOUT)
    failures = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + ("  " + detail if detail else ""))
        if not ok:
            failures.append(name)

    m = None
    try:
        for _ in range(60):
            try:
                m = M(MARIONETTE_PORT)
                break
            except Exception:
                time.sleep(1)
        if m is None:
            check("marionette", False, "never came up")
            return 1
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})

        tabs = []
        for _ in range(120):
            try:
                tabs = json.loads(m.js_async(TABS))
                if isinstance(tabs, list) and tabs:
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if not tabs:
            check("host replies", False, "no tab list")
            return 1

        def wait_for(predicate, seconds=20.0):
            end = time.time() + seconds
            last = None
            while time.time() < end:
                last = json.loads(m.js(STATE))
                if predicate(last):
                    return last
                time.sleep(0.15)
            return last

        def create(path):
            r = json.loads(m.js_async(CREATE, [f"http://{HOST}:{PORT}/{path}"]))
            return r.get("astra_tab_id")

        id_a = create("a")
        wait_for(lambda s: s.get("uri", "").endswith("/a"))
        time.sleep(1.0)
        id_b = create("b")
        wait_for(lambda s: s.get("uri", "").endswith("/b"))
        time.sleep(1.0)
        check("two pages created", bool(id_a and id_b), f"{id_a} {id_b}")

        # Return to A; it must be the selected, presented, active tab.
        m.js_async("""const id = arguments[0];
        const done = arguments[arguments.length - 1];
        (async () => { await window.__astraHost.Tabs.select({request_id:'reassert', astra_tab_id:id}); done('ok'); })();""",
                   [id_a])
        state = wait_for(lambda s: s.get("uri", "").endswith("/a") and s.get("panelMatches"))
        check("A is selected and presented", state.get("uri", "").endswith("/a") and state.get("panelMatches"), json.dumps(state))
        check("A starts active", state.get("docActive") is True, json.dumps(state))

        # 1. The deck drifted to another tab while selectedTab stayed A. First
        # prove the engine's own selection of the already-selected tab is a
        # no-op, which is what makes the host repair necessary.
        drifted = json.loads(m.js(DRIFT))
        check("deck drift forced", drifted.get("shownId") != drifted.get("selectedPanelId"), json.dumps(drifted))
        noop = json.loads(m.js("""return JSON.stringify((() => {
          const gb = window.gBrowser;
          gb.selectedTab = gb.selectedTab;
          const selected = gb.selectedTab;
          return { panelMatches: gb.tabpanels.selectedPanel === gb.tabContainer.getRelatedElement(selected) };
        })())"""))
        check("re-selecting the tab is a no-op in the engine", noop.get("panelMatches") is False, json.dumps(noop))
        clicked = m.js(CLICK_ROW, [id_a])
        time.sleep(0.6)
        after = json.loads(m.js(STATE))
        check("row click repairs a drifted deck", clicked == "ok" and after.get("panelMatches") is True, json.dumps(after))

        # 2. The window is activated after another app was in front: the page
        # is put back without any tab switch at all.
        m.js(DRIFT)
        pre = json.loads(m.js(STATE))
        m.js(ACTIVATE)
        time.sleep(0.6)
        now = json.loads(m.js(STATE))
        check(
            "window activation repairs the deck",
            pre.get("panelMatches") is False and now.get("panelMatches") is True,
            json.dumps({"before": pre, "after": now}),
        )
    finally:
        if m is not None:
            try:
                m.cmd("Marionette:Quit", {})
            except Exception:
                pass
        try:
            proc.terminate()
        except Exception:
            pass
        server.shutdown()
        log.close()

    print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump({"failures": failures}, fh, indent=2)
    return 0 if not failures else 1


sys.exit(main())
