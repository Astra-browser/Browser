"""Live probe: a site's window.open popup stays a small popup, not a browser.

A page that signs in through an OAuth provider calls
`window.open(url, name, "width=...,height=...")`. Firefox answers that with a
chrome popup window: no toolbars, the requested size, and the page may close it
with `window.close()` when the flow is done. Astra must leave that window alone:
the full product shell (sidebar, tab row, address field) belongs to a browser
window, not to a sign-in popup.

The probe serves a parent page and a popup page, opens the popup the way a site
does, and checks the chrome window that appears:

  1. exactly one new chrome window, and it is a popup (`toolbar.visible` false,
     `chromehidden` carries `toolbar`);
  2. the window kept the requested 520x640 size (within the engine's clamp);
  3. the Astra shell is not mounted in it (no `.astra-frame`, no #astra-root
     chrome) and the native content deck is the visible surface;
  4. the parent window still shows the product shell and was not navigated;
  5. `window.close()` from the popup page closes the window and the parent
     survives.

Usage: python tools/marionette-probe/popup-window-probe.py [outdir]
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

ROOT = astra_env.ROOT
FIREFOX = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_POPUP_PORT", "2847"))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="astra-popup-")
os.makedirs(OUT, exist_ok=True)

if not os.path.exists(FIREFOX):
    print("SKIP no built binary at", FIREFOX)
    sys.exit(2)

REQUESTED_WIDTH = 520
REQUESTED_HEIGHT = 640
POPUP_TITLE = "Astra OAuth Popup"
PARENT_TITLE = "Astra OAuth Parent"

PARENT = """<!doctype html><meta charset="utf-8"><title>%s</title>
<body><h1 id="parent">parent page</h1>
<script>
window.__popup = null;
function openAuthPopup() {
  window.__popup = window.open(
    "/popup", "astra_oauth_popup",
    "width=%d,height=%d,left=120,top=90,menubar=no,toolbar=no,location=yes," +
    "status=no,resizable=yes,scrollbars=yes");
  return window.__popup !== null;
}
</script></body>""" % (PARENT_TITLE, REQUESTED_WIDTH, REQUESTED_HEIGHT)

POPUP = """<!doctype html><meta charset="utf-8"><title>%s</title>
<body><h1 id="popup">popup page</h1>
<script>
window.__ready = true;
function finish() { window.close(); }
</script></body>""" % POPUP_TITLE


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        body = POPUP.encode() if self.path.startswith("/popup") else PARENT.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % server.server_port
URL = BASE + "/"


class Marionette:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
        self.file = self.sock.makefile("rb")
        self.seq = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.file.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.file.read(length - len(rest))
            if not chunk:
                raise EOFError("marionette closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self.seq += 1
        payload = json.dumps([0, self.seq, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            message = self._read()
            if isinstance(message, list) and len(message) == 4 and message[1] == self.seq:
                if message[2]:
                    raise RuntimeError(
                        "%s -> %s: %s" % (method, message[2], json.dumps(message[3])[:300])
                    )
                return message[3]

    def js(self, script, args=None):
        return self.cmd(
            "WebDriver:ExecuteScript", {"script": script, "args": args or []}
        )["value"]


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
  const iter = Services.wm.getEnumerator("navigator:browser");
  while (iter.hasMoreElements()) {
    const w = iter.getNext();
    if (w.closed) continue;
    const doc = w.document;
    const root = doc.documentElement;
    const box = doc.getElementById("tabbrowser-tabbox");
    const frame = doc.querySelector(".astra-frame");
    let url = "";
    let contentTitle = "";
    try { url = w.gBrowser?.selectedBrowser?.currentURI?.spec ?? ""; } catch {}
    try { contentTitle = w.gBrowser?.selectedBrowser?.contentTitle ?? ""; } catch {}
    out.push({
      title: doc.title ?? "",
      url,
      content_title: contentTitle,
      chromehidden: root.getAttribute("chromehidden") ?? "",
      toolbar_visible: w.toolbar?.visible !== false,
      width: w.outerWidth,
      height: w.outerHeight,
      opener: w.opener !== null && typeof w.opener === "object",
      astra_root: !!doc.getElementById("astra-root"),
      astra_frame: !!frame,
      astra_booted: frame?.getAttribute("data-app-booted") ?? null,
      native_mounted: root.getAttribute("data-astra-native-mounted") === "true",
      deck_display: box ? w.getComputedStyle(box).display : null,
      popup_attr: root.hasAttribute("data-astra-popup"),
    });
  }
  return out;
})())"""

POPUP_HANDLE = """return (() => {
  const { NavigableManager } = ChromeUtils.importESModule(
    "chrome://remote/content/shared/NavigableManager.sys.mjs");
  const iter = Services.wm.getEnumerator("navigator:browser");
  while (iter.hasMoreElements()) {
    const w = iter.getNext();
    if (w.closed) continue;
    if ((w.document.documentElement.getAttribute("chromehidden") || "").includes("toolbar")) {
      return NavigableManager.getIdForBrowser(w.gBrowser.selectedBrowser);
    }
  }
  return "";
})()"""


def page_eval(session, handle, script):
    chrome_handle = session.cmd("WebDriver:GetWindowHandle")["value"]
    session.cmd("Marionette:SetContext", {"value": "content"})
    try:
        if handle:
            session.cmd("WebDriver:SwitchToWindow", {"handle": handle})
        return session.js(script)
    finally:
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        if chrome_handle:
            session.cmd("WebDriver:SwitchToWindow", {"handle": chrome_handle})

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS %s" % name)
    else:
        failed += 1
        print("FAIL %s %s" % (name, detail))


def main():
    profile = tempfile.mkdtemp(prefix="astra-popup-profile-")
    with open(os.path.join(profile, "user.js"), "w") as prefs:
        prefs.write(
            'user_pref("marionette.port", %d);\n'
            'user_pref("astra.onboarding.force", "skip");\n'
            % PORT
        )
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
        check("window booted", bool(wait(
            lambda: session.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"
            ), 60)))

        parent_id = session.js(
            "const w = Services.wm.getMostRecentWindow('navigator:browser');"
            "return w ? w.Services.astraHost.__bindCurrentWindow(w) : '';"
        )
        session.js(
            "return Services.astraHost.Tabs.create({request_id:'popup-parent',"
            " window_id: arguments[0], url: arguments[1], background:false})"
            ".then(r => JSON.stringify(r));",
            [parent_id, URL],
        )
        time.sleep(2)
        before = json.loads(session.js(WINDOWS))
        check("parent page is in the browser window",
              any(w.get("url", "").startswith(BASE) for w in before),
              json.dumps(before)[:400])

        handle = session.js(
            "const { NavigableManager } = ChromeUtils.importESModule("
            "'chrome://remote/content/shared/NavigableManager.sys.mjs');"
            "return NavigableManager.getIdForBrowser(gBrowser.selectedBrowser);"
        )
        opened = page_eval(session, handle, "return openAuthPopup();")
        check("the page opened a popup", opened is True, repr(opened))

        windows = wait(lambda: (lambda w: w if len(w) == 2 else None)(
            json.loads(session.js(WINDOWS))), 30)
        check("exactly two chrome windows", bool(windows),
              json.dumps(json.loads(session.js(WINDOWS)))[:500])
        if not windows:
            return
        popup = next((w for w in windows if "toolbar" in (w.get("chromehidden") or "")), None)
        parent = next((w for w in windows if w is not popup and w.get("url", "").startswith(BASE)), None)
        check("the new window is a popup", popup is not None, json.dumps(windows)[:500])
        check("the parent window is still there", parent is not None, json.dumps(windows)[:500])
        if not popup or not parent:
            return

        check("popup has no toolbar", popup["toolbar_visible"] is False, json.dumps(popup))
        check("popup is not a full-size browser window",
              (popup.get("width") or 0) < 900 and (popup.get("height") or 0) < 900,
              "%sx%s" % (popup.get("width"), popup.get("height")))

        popup_handle = session.js(POPUP_HANDLE)
        viewport = json.loads(page_eval(
            session, popup_handle,
            "return JSON.stringify({w: window.innerWidth, h: window.innerHeight});",
        )) if popup_handle else {}
        check("popup kept the requested page width (%d)" % REQUESTED_WIDTH,
              abs((viewport.get("w") or 0) - REQUESTED_WIDTH) <= 5,
              "innerWidth=%s" % viewport.get("w"))
        check("popup kept the requested page height (%d)" % REQUESTED_HEIGHT,
              abs((viewport.get("h") or 0) - REQUESTED_HEIGHT) <= 5,
              "innerHeight=%s" % viewport.get("h"))
        check("popup did not mount the Astra shell",
              popup["astra_frame"] is False and popup["astra_root"] is False,
              json.dumps(popup))
        check("popup is not adopted as an Astra window",
              popup["native_mounted"] is False, json.dumps(popup))
        check("popup marks itself as a popup", popup["popup_attr"] is True, json.dumps(popup))
        check("popup shows the native content deck",
              popup["deck_display"] not in (None, "none"), json.dumps(popup))
        check("parent still shows the product shell",
              parent["astra_frame"] is True and parent["astra_booted"] == "true",
              json.dumps(parent))
        check("parent was not navigated to the popup",
              "/popup" not in (parent.get("url") or ""), parent.get("url"))

        check("popup page rendered", popup.get("content_title") == POPUP_TITLE,
              popup.get("content_title"))

        closed = page_eval(session, popup_handle, "window.close(); return true;") if popup_handle else None
        check("popup page can close itself", bool(closed), repr(closed))
        gone = wait(lambda: len(json.loads(session.js(WINDOWS))) == 1, 20)
        check("the popup window is gone", bool(gone), json.dumps(json.loads(session.js(WINDOWS)))[:400])
        check("the browser window survives", process.poll() is None,
              "exit=%s" % process.poll())
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

    print("\npopup-window: %d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
