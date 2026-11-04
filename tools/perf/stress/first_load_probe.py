#!/usr/bin/env python3
"""First-vs-second load probe for real sites (Google, YouTube).

Measures:
  * first visit in the boot tab
  * second visit in a new tab (same origin -> warm process/cache)
  * same pair for youtube.com
  * network prefs that commonly add first-load latency

Run on the private compositor so it never appears on the desktop:
  tools/perf/hidden-display.sh python3 tools/perf/stress/first_load_probe.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FIREFOX = os.path.join(ROOT, "engine", "obj-astra-linux", "dist", "bin", "firefox")
PORT = int(os.environ.get("ASTRA_FIRST_LOAD_PORT", "2841"))


class M:
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
        n = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            rest += self.f.read(n - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]

    def execute(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def execute_async(self, script, args=None):
        return self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})["value"]


TABS = """const done = arguments[arguments.length - 1];
(async () => { try { const r = await window.__astraHost.Tabs.list({request_id:'p'}); done(JSON.stringify(r.tabs||[])); } catch(e){ done(JSON.stringify({error:String(e)})); } })();"""

CREATE = """const url = arguments[0]; const done = arguments[arguments.length - 1];
(async () => { try { const r = await window.__astraHost.Tabs.create({request_id:'p',url,background:false}); done(JSON.stringify(r)); } catch(e){ done(JSON.stringify({error:String(e)})); } })();"""

NAV = """const url = arguments[0]; const done = arguments[arguments.length - 1];
(async () => { try { const r = await window.__astraHost.Navigation.loadURL({request_id:'p',url}); done(JSON.stringify(r)); } catch(e){ done(JSON.stringify({error:String(e)})); } })();"""

STATE = """return JSON.stringify((() => {
  const b=gBrowser.selectedBrowser;
  let uri=null, title=null, loading=null;
  try{uri=b?.currentURI?.spec??null}catch(e){}
  try{title=b?.contentTitle??null}catch(e){}
  try{loading=b?.webProgress?.isLoadingDocument??null}catch(e){}
  return {uri,title,loading};
})())"""

PREFS = """return JSON.stringify((() => {
  const keys=['network.trr.mode','network.trr.uri','network.dns.disablePrefetch',
    'network.http.http3.enable','network.http.http2.enable','network.proxy.type',
    'browser.cache.disk.enable','browser.cache.memory.enable',
    'security.OCSP.enabled','network.dns.echconfig.enabled',
    'network.http.connection-timeout','network.http.response.timeout'];
  const out={};
  for(const k of keys){try{out[k]=Services.prefs.getPrefType(k)===0?null:String(Services.prefs.getCharPref(k,Services.prefs.getIntPref(k,Services.prefs.getBoolPref(k,''))))}catch(e){out[k]='ERR'}}
  return out;
})())"""


def selected(m):
    tabs = json.loads(m.execute_async(TABS))
    return next((t for t in tabs if t.get("selected")), tabs[0] if tabs else None)


def wait_loaded(m, host, timeout=30):
    start = time.monotonic()
    last = None
    while time.monotonic() - start < timeout:
        tab = selected(m)
        st = json.loads(m.execute(STATE))
        last = {"tab": tab, "state": st, "ms": round((time.monotonic() - start) * 1000, 1)}
        uri = st.get("uri") or ""
        if (host in uri and tab and tab.get("loading") is False and st.get("loading") is False):
            return last, True
        time.sleep(0.05)
    return last, False


def run_one(m, kind, url, host):
    t0 = time.monotonic()
    if kind == "navigate":
        out = json.loads(m.execute_async(NAV, [url]))
    else:
        out = json.loads(m.execute_async(CREATE, [url]))
    if "error" in out:
        return {"kind": kind, "url": url, "error": out["error"], "ms": round((time.monotonic() - t0) * 1000, 1)}
    last, ok = wait_loaded(m, host, timeout=30)
    return {"kind": kind, "url": url, "ok": ok, "ms": round((time.monotonic() - t0) * 1000, 1), "last": last}


def main():
    if not os.path.exists(FIREFOX):
        print("SKIP no binary")
        return 2
    profile = tempfile.mkdtemp(prefix="astra-first-load-")
    with open(os.path.join(profile, "user.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
        f.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        f.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        f.write('user_pref("media.autoplay.default", 0);\n')
    log = open(os.path.join(profile, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    results = []
    try:
        m = M(PORT)
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
            raise RuntimeError("app never ready")
        # Wait for the boot tab to exist.
        for _ in range(50):
            if selected(m):
                break
            time.sleep(0.1)
        results.append({"prefs": json.loads(m.execute(PREFS))})
        results.append(run_one(m, "navigate", "https://www.google.com/", "google.com"))
        results.append(run_one(m, "create", "https://www.google.com/", "google.com"))
        results.append(run_one(m, "create", "https://www.youtube.com/", "youtube.com"))
        results.append(run_one(m, "create", "https://www.youtube.com/", "youtube.com"))
    finally:
        try:
            proc.terminate(); proc.wait(timeout=15)
        except Exception:
            proc.kill()
        log.close()
        shutil.rmtree(profile, ignore_errors=True)
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
