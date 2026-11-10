"""Sidebar per-site shield: the toggle exists, names the page, pauses blocking
for that site, reloads, and turns it back on.

Usage: python3 tools/marionette-probe/sidebar-shield-probe.py <outdir>
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2828
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/sidebar-shield"
os.makedirs(OUT, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    hits = []

    def do_GET(self):
        Handler.hits.append(self.path)
        body = b"<html><head><title>Shield site</title></head><body>shield</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
site = f"http://127.0.0.1:{server.server_port}"
threading.Thread(target=server.serve_forever, daemon=True).start()


class Marionette:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", PORT), timeout=60)
        self.f = self.sock.makefile("rb")
        self.n = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            rest += self.f.read(length - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self.n += 1
        payload = json.dumps([0, self.n, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self.n:
                if msg[2]:
                    raise RuntimeError(f"{method}: {msg[2]} {json.dumps(msg[3])[:400]}")
                return msg[3]

    def script(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]


passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


profile = tempfile.mkdtemp(prefix="astra-shield-", dir="/tmp/opencode")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX),
    stdout=open(os.path.join(OUT, "stderr.log"), "wb"), stderr=subprocess.STDOUT)

m = None
for _ in range(80):
    try:
        m = Marionette()
        break
    except Exception:
        time.sleep(1)
check("marionette connects", m is not None)
if m is None:
    proc.terminate()
    raise SystemExit(1)
m.cmd("WebDriver:NewSession", {"capabilities": {}})
m.cmd("Marionette:SetContext", {"value": "chrome"})

for _ in range(60):
    try:
        if m.script("return document.querySelector('[data-astra-app]')?.dataset?.appReady === 'host';"):
            break
    except Exception:
        pass
    time.sleep(1)

# Blocking installs its lists after boot; the shield is unavailable until then.
for _ in range(45):
    try:
        if m.script('try { return Cc["@astra/blocker;1"].getService(Ci.nsIAstraBlockerService).initialized === true; } catch (e) { return false; }'):
            break
    except Exception:
        pass
    time.sleep(1)

m.script("""
return (async () => {
  const list = await Services.astraHost.Tabs.list({ request_id: "shield" });
  const selected = list.tabs.find((t) => t.selected) || list.tabs[0];
  await Services.astraHost.Navigation.loadURL({
    request_id: "shield-nav", astra_tab_id: selected.astra_tab_id, url: arguments[0] + "/page",
  });
  return selected.astra_tab_id;
})();
""", [site])
time.sleep(2)

READ = """
const frames = [...document.querySelectorAll('iframe')];
const app = document.querySelector('iframe.astra-app-frame')?.contentDocument;
const button = app?.querySelector('[data-astra-shield]');
let status = null;
try { status = await Services.astraHost.Blocker.status(); } catch (e) { status = { error: String(e) }; }
return {
  exists: !!button,
  state: button?.getAttribute('data-shield-state') ?? null,
  site: button?.getAttribute('data-shield-site') ?? null,
  label: button?.getAttribute('aria-label') ?? null,
  pressed: button?.getAttribute('aria-pressed') ?? null,
  paused: status?.site?.paused ?? null,
  applied: status?.applied_enabled ?? null,
  url: window.gBrowser?.selectedBrowser?.currentURI?.spec ?? "",
  protection: status?.protection ?? null,
  hasSite: !!status?.site,
  frames: frames.map((f) => ({ cls: f.className, doc: !!f.contentDocument,
    bar: !!f.contentDocument?.querySelector('.utility-bar'),
    shield: !!f.contentDocument?.querySelector('[data-astra-shield]') })),
  appBar: !!app?.querySelector('.utility-bar'),
};
"""

first = m.script("return (async () => { " + READ + " })();")
check("the sidebar shows a shield for the page", first.get("exists") is True, json.dumps(first))
check("it names the page's site", first.get("site") == "127.0.0.1", json.dumps(first))
check("it starts on", first.get("state") == "on" and first.get("pressed") == "true", json.dumps(first))
check("its label says it will turn blocking off", "Turn off blocking" in (first.get("label") or ""), json.dumps(first))

CLICK = """
const app = document.querySelector('iframe.astra-app-frame')?.contentDocument;
const button = app?.querySelector('[data-astra-shield]');
button?.click();
return !!button;
"""
m.script("return (async () => { " + CLICK + " })();")
time.sleep(3)
second = m.script("return (async () => { " + READ + " })();")
check("clicking pauses blocking for the site", second.get("paused") is True, json.dumps(second))
check("the toggle reads off", second.get("state") == "off" and second.get("pressed") == "false", json.dumps(second))
check("the page reloaded under the new policy",
      len([h for h in Handler.hits if h == "/page"]) >= 2, str(Handler.hits))

m.script("return (async () => { " + CLICK + " })();")
time.sleep(3)
third = m.script("return (async () => { " + READ + " })();")
check("clicking again resumes blocking", third.get("paused") is False, json.dumps(third))
check("the toggle reads on again", third.get("state") == "on", json.dumps(third))

print(f"\n{passed} passed, {failed} failed")
print("profile:", profile)
proc.terminate()
sys.exit(0 if failed == 0 else 1)
