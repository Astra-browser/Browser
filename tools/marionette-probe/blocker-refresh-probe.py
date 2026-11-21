#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live blocker document-lifecycle probe (D-38/D-42).

The page half of the blocker (cosmetic CSS + scriptlets) belongs to the
document, but its bookkeeping used to outlive one. This probe proves that every
document gets its own, working pass:

  * first load: the selector hides the element, the scriptlet runs, its trap is
    visible to the page's own scripts, a nested chain is trapped, the network
    hook cancels the image;
  * reload (the same tab, same origin): the same checks, plus the scriptlet is
    already installed before the document's first inline script;
  * repeated reloads stay covered;
  * a second and third tab opened on the same URL are covered;
  * switching back to the first tab keeps it covered.

Usage: python3 tools/marionette-probe/blocker-refresh-probe.py
Exit: 0 PASS, 1 FAIL.
"""
import json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY
PORT = 2893
HITS = {"ad": 0, "page": 0}

PAGE = b"""<!doctype html><html><head><title>Blocker lifecycle probe</title>
<script>window.astraProbeInline = window.astraProbeScriptlet === true;</script>
</head>
<body><h1>probe</h1><div class="astra-test-ad" id="ad-box">AD</div>
<img id="ad-img" src="/ad.png">
<script>window.astraProbeLate = window.astraProbeScriptlet === true;
window.astraNested = { adValue: 42 };
window.astraNestedRead = window.astraNested.adValue;</script>
</body></html>"""


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/ad.png"):
            HITS["ad"] += 1
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        HITS["page"] += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(PAGE)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]

    def js(self, s, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": args or []})["value"]

    def chrome(self):
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def content(self):
        self.cmd("Marionette:SetContext", {"value": "content"})


def wait(fn, timeout=90, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


# Marionette identifies a tab by the engine's own browser handle; the shared
# module is the same singleton the server uses, so the value round-trips.
HANDLE = r"""
const { NavigableManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/NavigableManager.sys.mjs");
return NavigableManager.getIdForBrowser(window.gBrowser.selectedBrowser);
"""

READ_DOC = r"""
const box = document.getElementById("ad-box");
return JSON.stringify({
  url: location.href,
  ready: document.readyState,
  display: box ? getComputedStyle(box).display : "missing",
  scriptlet: window.astraProbeScriptlet === true,
  inline: window.astraProbeInline === true,
  late: window.astraProbeLate === true,
  nested: window.astraNestedRead === undefined,
  styleNode: !!document.getElementById("astra-blocker-style"),
});
"""

RELOAD = "location.reload(); return true;"


def read_doc(m, handle):
    m.content()
    m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": True})
    return json.loads(m.js(READ_DOC))


def wait_doc(m, handle, target):
    return wait(
        lambda: (lambda d: d if d.get("ready") == "complete" and d.get("url", "").startswith(target) else None)(
            read_doc(m, handle)
        ),
        60,
    )


def select(m, astra_tab_id):
    m.chrome()
    m.js(
        "return Services.astraHost.Tabs.select({request_id:'lifecycle', astra_tab_id:arguments[0]});",
        [astra_tab_id],
    )
    return m.js(HANDLE)


def open_tab(m, target):
    m.chrome()
    created = json.loads(m.js(
        "return Services.astraHost.Tabs.create({request_id:'lifecycle', url:arguments[0], background:false})"
        ".then(r => JSON.stringify(r));", [target]))
    handle = m.js(HANDLE)
    return created.get("astra_tab_id") or created.get("tab_id"), handle


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def layers(view):
    return (
        view.get("display") == "none",
        view.get("scriptlet") is True,
        view.get("inline") is True,
        view.get("late") is True,
    )


server = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
url = f"http://127.0.0.1:{port}/"
profile = tempfile.mkdtemp(prefix="astra-blocker-lifecycle-")
with open(os.path.join(profile, "prefs.js"), "w") as f:
    f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
log = open(os.path.join(profile, "log"), "wb")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
)
failures = []

try:
    m = M(PORT)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.chrome()
    wait(lambda: m.js("return !!Services?.astraHost;"), 90)
    m.js("return Services.astraHost.Blocker.status().then(s => s.protection);")
    wait(lambda: m.js(
        "return Services.astraHost.Blocker.status().then(s => s.protection === 'active' ? 'yes' : '');"
    ), 120)

    # One install: a network rule, a cosmetic rule and a scriptlet rule, so all
    # three document-scoped layers are observable on the same page.
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setEnabled(true);"
        "s.installRules(arguments[0]); return s.status();",
        ["||127.0.0.1^$image\n127.0.0.1##.astra-test-ad\n"
         "127.0.0.1##+js(set-constant, astraProbeScriptlet, true)\n"
         "127.0.0.1##+js(set-constant, astraNested.adValue, undefined)\n"],
    )

    first_id, first = open_tab(m, url)
    time.sleep(0.5)
    view = wait_doc(m, first, url)
    check("first load: page loaded", bool(view), json.dumps(view))
    check("first load: cosmetic selector hides the element", layers(view or {})[0], json.dumps(view))
    check("first load: scriptlet ran", layers(view or {})[1], json.dumps(view))
    check("first load: the page realm sees the scriptlet", layers(view or {})[3], json.dumps(view))
    check("first load: network hook cancelled the image", HITS["ad"] == 0, f"hits={HITS['ad']}")

    for attempt in (1, 2, 3):
        before = HITS["page"]
        m.content()
        m.cmd("WebDriver:SwitchToWindow", {"handle": first, "focus": True})
        m.js(RELOAD)
        time.sleep(0.4)
        wait_doc(m, first, url)
        # Give a late actor a moment, then read again: a document that is never
        # covered must not be rescued by the wait.
        time.sleep(1.5)
        view = read_doc(m, first)
        hidden, scriptlet, inline, late = layers(view)
        check(f"reload {attempt}: page loaded", view.get("ready") == "complete" and HITS["page"] > before,
              json.dumps(view))
        check(f"reload {attempt}: cosmetic selector hides the element", hidden, json.dumps(view))
        check(f"reload {attempt}: scriptlet ran", scriptlet, json.dumps(view))
        check(f"reload {attempt}: scriptlet precedes the inline script", inline, json.dumps(view))
        check(f"reload {attempt}: the page realm sees the scriptlet", late, json.dumps(view))
        check(f"reload {attempt}: a nested chain is trapped", view.get("nested") is True, json.dumps(view))
        check(f"reload {attempt}: network hook cancelled the image", HITS["ad"] == 0, f"hits={HITS['ad']}")

    second_id, second = open_tab(m, url)
    time.sleep(0.5)
    view = wait_doc(m, second, url)
    check("second tab: cosmetic selector hides the element", layers(view or {})[0], json.dumps(view))
    check("second tab: scriptlet ran", layers(view or {})[1], json.dumps(view))

    third_id, third = open_tab(m, url)
    time.sleep(0.5)
    view = wait_doc(m, third, url)
    check("third tab: cosmetic selector hides the element", layers(view or {})[0], json.dumps(view))
    check("third tab: scriptlet ran", layers(view or {})[1], json.dumps(view))

    back = select(m, first_id)
    view = read_doc(m, back)
    check("switch back to the first tab keeps it covered",
          layers(view)[0] and layers(view)[1], json.dumps(view))
    check("network hook cancelled every ad image", HITS["ad"] == 0, f"hits={HITS['ad']}")
    print("HITS", HITS)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
    server.shutdown()

print("blocker lifecycle:", "PASS" if not failures else f"FAIL ({len(failures)}: {failures})")
sys.exit(0 if not failures else 1)
