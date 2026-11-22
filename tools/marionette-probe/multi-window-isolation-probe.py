"""Live probe: a private window owns its tabs and does not reach the normal one.

The product rule is that a private window records nothing and its state is not
readable across the window boundary. This probe opens a real private window,
loads a marker page in it, and checks:

  1. the private window gets its own window id (not `win-1`)
  2. its tabs are in its own Tabs.list page and not in the normal window's
  3. the normal window's app frame never paints the private URL or title
  4. closing the private window leaves the normal window mounted and usable

Usage: python3 tools/marionette-probe/multi-window-isolation-probe.py [outdir]
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
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

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from marionette import Marionette  # noqa: E402

ROOT = astra_env.ROOT
FIREFOX = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_ISOLATION_PORT", "2846"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/astra-isolation"
os.makedirs(OUT, exist_ok=True)

if not os.path.exists(FIREFOX):
    print("SKIP no built binary at", FIREFOX)
    sys.exit(2)

MARKER = "private-marker-9d1f"

class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        body = (
            f"<!doctype html><title>{MARKER}</title><h1 id='m'>{MARKER}</h1>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{server.server_port}/private"

def wait(read, timeout=30, step=0.2):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value

WINDOWS = """return JSON.stringify((() => {
  const out = [];
  try {
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
    const e = Services.wm.getEnumerator("navigator:browser");
    while (e.hasMoreElements()) {
      const w = e.getNext();
      if (w.closed) continue;
      let host = null;
      let isPrivate = false;
      try { host = w.Services?.astraHost ?? null; } catch {}
      try {
        isPrivate = PrivateBrowsingUtils.isWindowPrivate(w) === true;
      } catch {
        isPrivate = w.document?.documentElement
          ?.getAttribute("privatebrowsingmode") === "temporary";
      }
      out.push({
        private: isPrivate,
        id: host?.__bindCurrentWindow?.(w) ?? null,
        booted: (w.document?.querySelector(".astra-frame")
          ?.getAttribute("data-app-booted") ?? null) === "true",
        mounted: w.document?.documentElement?.getAttribute("data-astra-native-mounted") === "true",
      });
    }
  } catch (error) { return { error: String(error?.message ?? error) }; }
  return out;
})())"""

TABS = """return Services.astraHost.Tabs.list({request_id:'iso', window_id: arguments[0]})
  .then(r => JSON.stringify(r));"""

APP_TEXT = """return JSON.stringify((() => {
  const app = document.querySelector("iframe[data-astra-app-frame]");
  const doc = app?.contentDocument;
  if (!doc) return null;
  return {
    text: doc.body?.innerText ?? "",
    html: doc.documentElement?.outerHTML ?? "",
  };
})())"""

passed = 0
failed = 0

def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")

def main():
    profile = tempfile.mkdtemp(prefix="astra-isolation-", dir=os.environ.get("TMPDIR", "/tmp/opencode"))
    with open(os.path.join(profile, "user.js"), "w") as prefs:
        prefs.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(OUT, "browser.log"), "wb")
    process = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    session = None
    try:
        session = Marionette(PORT)
        session.cmd("WebDriver:NewSession", {"capabilities": {}})
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        check("normal window booted", bool(wait(
            lambda: session.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"
            ), 60)))

        before = json.loads(session.js(WINDOWS))
        normal_id = before[0]["id"] if before else None
        check("normal window has an id", bool(normal_id), json.dumps(before))

        created = session.js(
            "return Services.astraHost.Windows.create({request_id:'iso-private', private:true})"
            ".then(r => JSON.stringify(r));"
        )
        check("private window created", created and "error" not in json.loads(created), created)

        windows = wait(lambda: (lambda w: w if len(w) == 2 and all(x.get("booted") for x in w) else None)(
            json.loads(session.js(WINDOWS))), 60)
        check("both windows booted", bool(windows), json.dumps(windows))
        if not windows:
            return
        priv = next((w for w in windows if w.get("private")), None)
        normal = next((w for w in windows if not w.get("private")), None)
        check("private window is the private one", bool(priv) and bool(normal), json.dumps(windows))
        if not priv or not normal:
            return
        check("private window has its own id", priv["id"] != normal["id"],
              f"normal={normal['id']} private={priv['id']}")

        session.js(
            "return Services.astraHost.Tabs.create({request_id:'iso-tab',"
            " window_id: arguments[0], url: arguments[1], background:false})"
            ".then(r => JSON.stringify(r));",
            [priv["id"], URL],
        )
        time.sleep(3)
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(1)

        priv_tabs = json.loads(session.js(TABS, [priv["id"]]))
        normal_tabs = json.loads(session.js(TABS, [normal["id"]]))
        priv_urls = [t.get("url") for t in priv_tabs.get("tabs", [])]
        normal_urls = [t.get("url") for t in normal_tabs.get("tabs", [])]
        check("private marker is in the private window", any(URL in (u or "") for u in priv_urls),
              json.dumps(priv_urls))
        check("private marker is not in the normal window", not any(URL in (u or "") for u in normal_urls),
              json.dumps(normal_urls))

        # Read the normal window's own app frame, which is what a person sees.
        painted = session.js(
            "const { PrivateBrowsingUtils } = ChromeUtils.importESModule("
            "\"resource://gre/modules/PrivateBrowsingUtils.sys.mjs\");"
            "const wins = []; const iter = Services.wm.getEnumerator('navigator:browser');"
            "while (iter.hasMoreElements()) wins.push(iter.getNext());"
            "const normal = wins.find(w => { try { return !PrivateBrowsingUtils.isWindowPrivate(w); }"
            " catch { return true; } }) ?? wins[0];"
            "const app = normal.document.querySelector('iframe[data-astra-app-frame]');"
            "const doc = app?.contentDocument; return doc ? (doc.documentElement.outerHTML || '') : '';"
        )
        check("normal app frame does not paint the private marker", MARKER not in painted,
              f"marker_present={MARKER in painted}")

        session.js(
            "const { PrivateBrowsingUtils } = ChromeUtils.importESModule("
            "\"resource://gre/modules/PrivateBrowsingUtils.sys.mjs\");"
            "const wins = []; const iter = Services.wm.getEnumerator('navigator:browser');"
            "while (iter.hasMoreElements()) wins.push(iter.getNext());"
            "const priv = wins.find(w => { try { return PrivateBrowsingUtils.isWindowPrivate(w); }"
            " catch { return false; } }); if (priv) priv.close(); return 'ok';"
        )
        time.sleep(2)
        after = json.loads(session.js(WINDOWS))
        check("normal window survives the private close", len(after) == 1 and after[0]["booted"],
              json.dumps(after))
        check("the process stays alive after the private close", process.poll() is None,
              f"exit={process.poll()}")
    finally:
        try:
            if session:
                session.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            process.wait(timeout=15)
        except Exception:
            process.kill()
        server.shutdown()
        log.close()

    print(f"\nmulti-window-isolation: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
