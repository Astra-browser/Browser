#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live probe for Astra's native shield features.

Covers, against the packaged dev build and a loopback server:
  removeparam, redirect resource substitution, bounce unwrapping, CNAME
  enforcement, Block Scripts, per-site shields, custom rules, cookie modes,
  per-site cookie permissions, forget-on-close, fingerprinting modes,
  language spoofing and bounce tracking protection.

Usage: tools/perf/hidden-display.sh python3 tools/marionette-probe/shields-probe.py
Exit: 0 PASS, 1 FAIL.
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
PORT = 2897
STATE = {"hits": {}, "paths": [], "lang": []}


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        STATE["hits"][path] = STATE["hits"].get(path, 0) + 1
        STATE["paths"].append(self.path)
        STATE["lang"].append(self.headers.get("Accept-Language", ""))
        if path == "/ad.png":
            body = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path in ("/site-script.js", "/ads.js"):
            body = b"window.astra_script_ran = (window.astra_script_ran || 0) + 1;"
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/set-cookie":
            body = b"<!doctype html><title>cookie</title><script>document.cookie='astra=1; path=/';</script>"
        elif path == "/dest":
            body = b"<!doctype html><title>dest</title><h1>destination</h1>"
        elif path == "/echo":
            body = ("<!doctype html><title>echo</title><p>" + self.path + "</p>").encode()
        else:
            body = b"""<!doctype html><title>shields</title>
<h1>shields</h1><div class="astra-test-ad">AD</div>
<img id="ad" src="/ad.png"><img id="redir" src="/redir.png"><img id="redir2" src="/redir2.png"><img id="custom" src="/custom.png">
<script src="/site-script.js"></script>
<script src="/ads.js"></script>
<script>window.inlineRan = true;</script>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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

    def chrome(self):
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def content(self):
        self.cmd("Marionette:SetContext", {"value": "content"})


def wait(fn, timeout=90, step=0.4):
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
base = f"http://127.0.0.1.nip.io:{port}"

profile = tempfile.mkdtemp(prefix="astra-shields-")
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


def reset_hits():
    STATE["hits"].clear()
    STATE["paths"].clear()


def hits(path):
    return STATE["hits"].get(path, 0)


def navigate(m, url):
    tab = m.js("return Services.astraHost.Tabs.list({request_id:'id'}).then(r => r.selected_tab_id);")
    return m.js(
        "return Services.astraHost.Navigation.loadURL({request_id:'live', astra_tab_id:arguments[0], url:arguments[1]});",
        [tab, url],
    )


def wait_page(m, marker, timeout=25):
    m.content()
    end = time.time() + timeout
    while time.time() < end:
        try:
            if m.js(f"return document.title === {json.dumps(marker)} ? 'yes' : '';"):
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


try:
    m = M(PORT)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.chrome()
    wait(lambda: m.js("return !!Services?.astraHost;"), 120)
    active = wait(
        lambda: m.js(
            "return Services.astraHost.Blocker.status().then(s => s.protection === 'active' ? 'yes' : '');"
        ),
        120,
    )
    check("blocker active", active == "yes")

    # ---- engine feature rules on a tiny deterministic set -----------------
    rules = "\n".join(
        [
            "||127.0.0.1.nip.io^$image,redirect=1x1-transparent.gif",
            "||127.0.0.1.nip.io^$removeparam=utm_source",
            "||127.0.0.1.nip.io^$image",
            "/\\/ads\\.js$/$script",
            "||doubleclick.net^",
            "127.0.0.1.nip.io##.astra-test-ad",
        ]
    )
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setEnabled(true); s.installRules(arguments[0]); return 'ok';",
        [rules],
    )
    time.sleep(0.5)
    diag = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "return JSON.stringify({"
        "redir:s.checkUrl(arguments[0], arguments[1], 'image'),"
        "echo:s.checkUrl(arguments[2], arguments[1], 'document'),"
        "ads:s.checkUrl(arguments[3], arguments[1], 'script'),"
        "redir2:s.checkUrl(arguments[4], arguments[1], 'image'),"
        "custom:s.checkUrl(arguments[5], arguments[1], 'image')"
        "});",
        [base + "/redir.png", base + "/", base + "/echo?utm_source=abc&keep=1", base + "/ads.js", base + "/redir2.png", base + "/custom.png"],
    ))
    print("DIAG", json.dumps(diag))

    # Redirect resource substitution: the element loads a 1px placeholder and
    # the server never sees /redir.png.
    reset_hits()
    navigate(m, base + "/")
    check("probe page loaded", wait_page(m, "shields"), "title")
    m.content()
    redir = m.js(
        "const i=document.getElementById('redir');"
        "return JSON.stringify({w:i?i.naturalWidth:-1,h:i?i.naturalHeight:-1,src:i?i.currentSrc:''});"
    )
    m.chrome()
    info = json.loads(redir)
    check("redirect resource substituted", hits("/redir.png") == 0 and info.get("w") == 1, f"{info} hits={hits('/redir.png')}")
    m.content()
    hidden = m.js(
        "const el=document.querySelector('.astra-test-ad');"
        "return el ? getComputedStyle(el).display : 'missing';"
    )
    m.chrome()
    check("cosmetic rule hid the ad box", hidden == "none", f"display={hidden}")

    # Ad-script heuristic (generic /ads.js rule).
    check("ad-script heuristic blocked /ads.js", hits("/ads.js") == 0, f"hits={hits('/ads.js')}")
    check("normal page script still loaded", hits("/site-script.js") >= 1, f"hits={hits('/site-script.js')}")

    # removeparam.
    reset_hits()
    navigate(m, base + "/echo?utm_source=abc&keep=1")
    check("removeparam page loaded", wait_page(m, "echo"), "title")
    seen = [p for p in STATE["paths"] if p.startswith("/echo")]
    check(
        "removeparam stripped utm_source",
        bool(seen) and "utm_source" not in seen[0] and "keep=1" in seen[0],
        str(seen),
    )

    # CNAME enforcement: mark the loopback host as cloaked and prove the hook
    # cancels the next request.
    m.chrome()
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setCloakedHost('127.0.0.1.nip.io', true); return 'ok';"
    )
    reset_hits()
    navigate(m, base + "/")
    time.sleep(2.5)
    cloaked_hits = hits("/")
    m.chrome()
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setCloakedHost('127.0.0.1.nip.io', false); return 'ok';"
    )
    check("CNAME-cloaked host is blocked", cloaked_hits == 0, f"hits={cloaked_hits}")

    # Block Scripts per-site (and the global inline-script CSP).
    reset_hits()
    m.js("Services.prefs.setBoolPref('astra.blocker.block-scripts', true); return 'ok';")
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setSitePolicy('127.0.0.1.nip.io', true, false, true); return 'ok';"
    )
    navigate(m, base + "/")
    wait_page(m, "shields")
    check("per-site Block Scripts cancelled scripts", hits("/site-script.js") == 0, f"hits={hits('/site-script.js')}")
    inline = m.js("return typeof window.inlineRan === 'undefined' ? 'blocked' : 'ran';")
    check("Block Scripts stopped the inline script", inline == "blocked", inline)
    m.chrome()
    m.js("Services.prefs.setBoolPref('astra.blocker.block-scripts', false); return 'ok';")
    m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "s.setSitePolicy('127.0.0.1.nip.io', true, false, false); return 'ok';"
    )

    # Service-level classify + bounce.
    cls = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "return s.classifyHost('doubleclick.net');"
    ))
    check("classifyHost identifies a tracker", cls.get("tracker") is True, json.dumps(cls))
    bounce = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "return s.classifyBounce(arguments[0]);",
        [f"https://www.google.com/url?q={base}/dest"],
    ))
    check("classifyBounce unwraps a redirector", bounce.get("target") == f"{base}/dest", json.dumps(bounce))

    # Bounce unwrapping on a real navigation.
    reset_hits()
    navigate(m, "https://www.google.com/url?q=" + base + "/dest")
    ok_bounce = wait_page(m, "dest", 20)
    check("bounce navigation opens the destination", ok_bounce and hits("/dest") >= 1, f"title_ok={ok_bounce} hits={hits('/dest')}")

    # ---- Host privacy surface --------------------------------------------
    m.chrome()
    state0 = json.loads(m.js("return Services.astraHost.Privacy.state().then(v => JSON.stringify(v));"))
    check("privacy state reads", state0.get("cookies") in ("allow", "block-third-party", "partition"), json.dumps(state0)[:200])

    configured = json.loads(m.js(
        "return Services.astraHost.Privacy.configure({cookies:'block-third-party', fingerprinting:'aggressive', language:true, screen:true, bounce_protection:true}).then(v=>JSON.stringify(v));"
    ))
    pref = m.js("return Services.prefs.getIntPref('network.cookie.cookieBehavior', -1);")
    overrides = m.js("return Services.prefs.getStringPref('privacy.fingerprintingProtection.overrides','');")
    btp = m.js("return Services.prefs.getIntPref('privacy.bounceTrackingProtection.mode', -1);")
    check("cookie mode reached the engine pref", configured.get("accepted") is True and pref == 1, f"{pref}")
    check("fingerprint mode set an aggressive target set", "ScreenRect" in overrides and "JSLocale" in overrides, overrides[:120])
    check("bounce tracking protection enabled", btp == 1, f"mode={btp}")

    # Language header spoof.
    reset_hits()
    navigate(m, base + "/echo?lang=1")
    wait_page(m, "echo")
    check("Accept-Language spoof reached the request", any("en-US" in v for v in STATE["lang"]), str(STATE["lang"][-4:]))

    # Per-site cookie block: setting document.cookie must not persist.
    m.chrome()
    site_block = json.loads(m.js("return Services.astraHost.Privacy.siteConfigure({host:'127.0.0.1.nip.io', cookies:'block'}).then(v=>JSON.stringify(v));"))
    perm_http = m.js("try { const u=Services.io.newURI('http://127.0.0.1.nip.io/'); const p=Services.scriptSecurityManager.createContentPrincipal(u,{}); return Services.perms.testExactPermissionFromPrincipal(p,'cookie'); } catch(e){ return 'ERR '+String(e); }")
    print("SITE_COOKIE_BLOCK", json.dumps(site_block), "perm_http", perm_http)
    navigate(m, base + "/set-cookie")
    wait_page(m, "cookie")
    m.content()
    cookie = m.js("return document.cookie;")
    m.chrome()
    check("per-site cookie block prevented the cookie", cookie == "", f"cookie={cookie!r}")

    # Allow restores the cookie path.
    m.js("return Services.astraHost.Privacy.siteConfigure({host:'127.0.0.1.nip.io', cookies:'allow'}).then(v=>JSON.stringify(v));")
    navigate(m, base + "/set-cookie")
    wait_page(m, "cookie")
    m.content()
    cookie_ok = m.js("return document.cookie;")
    m.chrome()
    check("per-site cookie allow permitted the cookie", "astra=1" in cookie_ok, f"cookie={cookie_ok!r}")

    # Forget on close / explicit forget clears it.
    forgot = json.loads(m.js(
        "return Services.astraHost.Privacy.forgetSite({host:'127.0.0.1.nip.io'}).then(v=>JSON.stringify(v));"
    ))
    time.sleep(0.5)
    cookies = m.js(
        "try { return Services.cookies.getCookiesFromHost('127.0.0.1.nip.io', {}).length; } catch(e) { return -1; }"
    )
    check("forget site accepted", forgot.get("accepted") is True, json.dumps(forgot))
    check("forget site cleared cookies", cookies == 0, f"cookies={cookies}")

    # User rules through the Host (also proves the reinstall path).
    host_rules = "||127.0.0.1.nip.io^$image"
    applied = json.loads(m.js(
        "return Services.astraHost.Blocker.configure({user_rules:arguments[0]}).then(v=>JSON.stringify(v));",
        [host_rules],
    ))
    time.sleep(1.0)
    lists = json.loads(m.js("return Services.astraHost.Blocker.lists().then(v=>JSON.stringify(v));"))
    check("user rules configure admitted", applied.get("accepted") is True, json.dumps(applied)[:160])
    check("user rules are projected", host_rules in (lists.get("user_rules") or ""), (lists.get("user_rules") or "")[:80])
    host_check = m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "return s.checkUrl(arguments[0], arguments[1], 'image');",
        [base + "/custom.png", base + "/"],
    )
    print("HOST_CHECK", host_check)
    reset_hits()
    navigate(m, base + "/")
    wait_page(m, "shields")
    check("user rule blocked /custom.png", hits("/custom.png") == 0, f"hits={hits('/custom.png')} check={host_check}")
    check("defaults include social and cookie lists", any(l["id"] == "social-media-blocker" and l["enabled"] for l in lists["lists"]) and any(l["id"] in ("easylist-cookie", "ublock-filters-cookie-notices") and l["enabled"] for l in lists["lists"]), "enabled defaults")
    check("Astra telemetry list is enabled", any(l["id"] == "astra-telemetry" and l["enabled"] for l in lists["lists"]))

    # System-resolver CNAME fallback: getaddrinfo does not expose a canonical
    # name on every platform, so the engine queries the CNAME RR directly.
    m.chrome()
    cname = json.loads(m.js(
        "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
        "return s.cname('www.apple.com');"
    ))
    check(
        "CNAME lookup returns the real chain",
        bool(cname.get("chain")) and any(
            "aaplimg" in entry or "akamaiedge" in entry
            for entry in cname.get("chain", [])
        ),
        json.dumps(cname),
    )

    # Restore a sane profile state for the next run.
    m.chrome()
    m.js("return Services.astraHost.Privacy.configure({cookies:'partition', fingerprinting:'standard', language:false, screen:false}).then(v=>JSON.stringify(v));")
    m.js("return Services.astraHost.Blocker.configure({user_rules:''}).then(v=>JSON.stringify(v));")
finally:
    try:
        proc.terminate()
        proc.wait(timeout=15)
    except Exception:
        proc.kill()
    log.close()

print("shields live:", "PASS" if not failures else "FAIL: " + ", ".join(failures))
sys.exit(0 if not failures else 1)
