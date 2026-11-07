#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live blocker probe (D-38/D-42).

Proves the packaged build end to end:
  * the Host API installs the bundled seed and reaches `active`;
  * the catalog, schedule and list membership round-trip;
  * the native channel hook cancels a matching image before the server sees it;
  * the page actor hides a cosmetic match;
  * counters advance and reset;
  * the Settings surface renders the catalog and the schedule controls.

The custom two-line rule set near the middle proves the hook deterministically
on a loopback server; the Host install (155k rules) is checked separately.

Usage: python3 tools/marionette-probe/blocker-probe.py
Exit: 0 PASS, 1 FAIL.
"""
import json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2891
HITS = {"ad": 0, "page": 0}


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/ad.png"):
            HITS["ad"] += 1
            body = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        HITS["page"] += 1
        body = b"""<!doctype html><html><head><title>Blocker probe</title></head>
<body><h1>probe</h1><div class="astra-test-ad" id="ad-box">AD</div>
<img id="ad-img" src="/ad.png"></body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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


def wait(fn, timeout=90, step=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


server = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
url = f"http://127.0.0.1:{port}/"
profile = tempfile.mkdtemp(prefix="astra-blocker-live-")
with open(os.path.join(profile, "prefs.js"), "w") as f:
    f.write(f'user_pref("marionette.port", {PORT});\n')
log = open(os.path.join(profile, "log"), "wb")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
)
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


try:
    m = M(PORT)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    wait(lambda: m.js("return !!Services?.astraHost;"), 90)

    # Host status triggers the bundled-seed install on a clean profile.
    first = m.js("return Services.astraHost.Blocker.status().then(s => JSON.stringify(s));")
    print("STATUS0", first)
    active = wait(
        lambda: m.js(
            "return Services.astraHost.Blocker.status().then(s => s.protection === 'active' ? 'yes' : '');"
        ),
        120,
    )
    check("host status reaches active", active == "yes")

    lists = json.loads(
        m.js("return Services.astraHost.Blocker.lists().then(v => JSON.stringify(v));")
    )
    check("catalog exposes lists", isinstance(lists, dict) and len(lists.get("lists", [])) > 20,
          f"{len(lists.get('lists', []))} lists")
    check("catalog marks the default set", sum(1 for x in lists["lists"] if x["enabled"]) >= 2,
          f"{sum(1 for x in lists['lists'] if x['enabled'])} enabled")
    check("installed rules are reported", lists.get("installed_rules", 0) > 100,
          str(lists.get("installed_rules")))

    configured = json.loads(
        m.js(
            "return Services.astraHost.Blocker.configure({list_ids:['easylist','easyprivacy'],"
            "update_hours:6, auto_update:true, cosmetic:true, scriptlets:true})"
            ".then(r => JSON.stringify(r));"
        )
    )
    check("configure is admitted", configured.get("accepted") is True, json.dumps(configured)[:200])
    lists2 = json.loads(
        m.js("return Services.astraHost.Blocker.lists().then(v => JSON.stringify(v));")
    )
    check("configure persists the schedule", lists2.get("update_hours") == 6)
    check("configure persists list membership", sum(1 for x in lists2["lists"] if x["enabled"]) == 2)

    # A tiny custom rule set proves the pre-connect hook itself, including a
    # cosmetic rule for the actor in the same install.
    rules = "||127.0.0.1^$image\n127.0.0.1##.astra-test-ad\n"
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setEnabled(true); s.installRules(arguments[0]); return s.status();",
        [rules],
    )

    HITS["ad"] = 0
    HITS["page"] = 0
    m.js(
        "return Services.astraHost.Navigation.loadURL({request_id:'live', astra_tab_id:arguments[0], url:arguments[1]});",
        [m.js("return Services.astraHost.Tabs.list({request_id:'id'}).then(r => r.selected_tab_id);"), url],
    )
    time.sleep(4)
    m.cmd("Marionette:SetContext", {"value": "content"})
    page = m.js("return document.readyState + '|' + location.href;")
    hidden = m.js(
        "const el=document.getElementById('ad-box'); return el ? getComputedStyle(el).display : 'missing';"
    )
    img = m.js("return !!document.getElementById('ad-img');")
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    check("probe page loaded", page.startswith("complete|") and str(port) in page, page)
    check("network hook cancelled the ad image", HITS["ad"] == 0, f"hits={HITS['ad']}")
    check("page itself still loaded", HITS["page"] >= 1, f"hits={HITS['page']}")
    style = m.js("return !!document.getElementById('astra-blocker-style');")
    actor = m.js("""
      try {
        const {AstraBlockerParent} = ChromeUtils.importESModule("resource://astra/actors/AstraBlockerParent.sys.mjs");
        ChromeUtils.registerWindowActor("AstraBlockerProbe", {
          parent: {esModuleURI: "resource://astra/actors/AstraBlockerParent.sys.mjs"},
          child: {esModuleURI: "resource://astra/actors/AstraBlockerChild.sys.mjs", events: {DOMContentLoaded: {}}},
          allFrames: true, includeChrome: false,
        });
        ChromeUtils.unregisterWindowActor("AstraBlockerProbe");
        return "ok:" + (typeof AstraBlockerParent);
      } catch (e) { return "err:" + String(e); }
    """)
    print("ACTOR", actor, "STYLE", style)
    check("cosmetic rule hid the element", hidden == "none", f"display={hidden}")
    check("page image element still exists", img is True)

    stats = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService); return s.stats();"
    ))
    check("blocked counter advanced", stats.get("blocks", 0) >= 1, json.dumps(stats))
    check("decision counter advanced", stats.get("decisions", 0) >= 1, json.dumps(stats))

    reset = json.loads(
        m.js("return Services.astraHost.Blocker.resetStats().then(r => JSON.stringify(r));")
    )
    stats2 = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService); return s.stats();"
    ))
    check("reset stats is admitted", reset.get("accepted") is True)
    check("reset clears the counters", stats2.get("blocks") == 0, json.dumps(stats2))

    # Service-level cosmetic lookup for the same page.
    cosmetic = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "return s.cosmeticFor(arguments[0], '[]', '[]');",
        [url],
    ))
    check("native cosmetic lookup returns selectors", ".astra-test-ad" in cosmetic.get("selectors", []),
          json.dumps(cosmetic)[:200])

    # Settings surface: the new catalog/controls must render in the real frame.
    m.js("return Services.astraHost.Commands.run({id:'settings.privacy'});")
    time.sleep(3)
    settings = m.js("""
      const frame = document.querySelector('.astra-app-frame');
      const doc = frame?.contentDocument;
      if (!doc) return JSON.stringify({frame:false});
      const text = doc.body?.innerText ?? '';
      const boxes = doc.querySelectorAll('.catalog input[type=checkbox]').length;
      return JSON.stringify({
        frame: true,
        title: text.includes('Ad, tracker and malware protection'),
        lists: text.includes('Filter lists'),
        schedule: text.includes('Check interval'),
        boxes,
        snippet: text.slice(Math.max(0, text.indexOf('Filter lists')), Math.max(0, text.indexOf('Filter lists')) + 400),
      });
    """)
    diag = m.js("""
      const frame = document.querySelector('.astra-app-frame');
      const w = frame?.contentWindow; const d = w?.document;
      return JSON.stringify({
        mode: d?.documentElement?.dataset?.bridgeMode ?? null,
        err: w?.__astraLastRelayError ?? null,
        host: !!w?.Services?.astraHost,
        relay: w?.__astraRelayCount ?? null,
      });
    """)
    print("DIAG", diag)
    print("SETTINGS", settings)
    view = json.loads(settings)
    check("settings page renders the blocker section", view.get("title") is True, settings)
    check("settings page renders the list catalog", view.get("lists") is True and view.get("boxes", 0) > 0, settings)
    check("settings page renders the schedule", view.get("schedule") is True, settings)

    print("HITS", HITS)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
    server.shutdown()

print("blocker live:", "PASS" if not failures else f"FAIL ({len(failures)}: {failures})")
sys.exit(0 if not failures else 1)
