"""Content probe: after a search, is the real page actually loading?

Usage: python3 tools/marionette-probe/content-probe.py <profile-dir> <out-dir>
"""
import base64
import json
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2828
FIREFOX = astra_env.BINARY
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

SEARCH = "return (() => {" + APP + """
  if (!d) return 'no doc';
  const input = d.querySelector('.address-field input');
  const form = input && input.closest('form');
  if (!input || !form) return 'no address field';
  input.focus();
  input.value = 'hello world';
  input.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
  form.dispatchEvent(new d.defaultView.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  return 'ok';
})()"""

STATE = "return JSON.stringify((() => {" + APP + """
  const slot = document.querySelector('[data-astra-content-slot]') || document.querySelector('.astra-content');
  const browser = document.querySelector('browser[data-astra-browser]');
  const read = (fn) => { try { return fn(); } catch (e) { return 'ERR ' + e.message; } };
  return {
    slotFound: !!slot,
    hasPage: slot ? slot.dataset.hasPage ?? null : null,
    browserFound: !!browser,
    uri: browser ? read(() => browser.currentURI.spec) : null,
    title: browser ? read(() => browser.contentTitle) : null,
    remote: browser ? browser.getAttribute('remote') : null,
    docShell: browser ? read(() => browser.docShell ? 'yes' : 'no') : null,
    sharedHost: d ? read(() => d.defaultView.parent !== d.defaultView && !!d.defaultView.parent.__astraHostModules) : null,
    parentSame: d ? read(() => d.defaultView.parent === d.defaultView) : null,
    parentHref: d ? read(() => d.defaultView.parent.location.href) : null,
    hasOwn: d ? read(() => Object.hasOwn(d.defaultView.parent, "__astraHostModules")) : null,
    keys: d ? read(() => Object.keys(d.defaultView.parent).filter((k) => k.startsWith("__")).join(",")) : null,
    appSeesModules: d ? read(() => d.defaultView.eval("typeof window.parent.__astraHostModules")) : null,
    appSeesHost: d ? read(() => d.defaultView.eval("typeof window.parent.__astraHost")) : null,
    bridgeMode: d ? read(() => (d.getElementById('root')?.dataset.bridgeMode) ?? null) : null,
    relayCount: read(() => window.__astraRelayCount ?? 0),
    bridgePath: d ? read(() => (d.getElementById('root')?.dataset.bridgePath) ?? null) : null,
    appProto: d ? read(() => d.defaultView.location.protocol) : null,
    appHref: d ? read(() => d.defaultView.location.href) : null,
    appScript: d ? read(() => d.querySelector('script[type="module"]')?.src ?? null) : null,
    rootKeys: d ? read(() => Object.keys(d.getElementById('root')?.dataset ?? {}).join(",")) : null,
    webNavigation: browser ? read(() => browser.webNavigation ? 'yes' : 'no') : null,
  };
})())"""


class M:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
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

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR,
        stdout=log, stderr=subprocess.STDOUT)
    m = None
    for _ in range(60):
        try:
            m = M(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("no marionette")
        proc.terminate()
        return 1
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(20)

    print("before:", m.js(STATE))
    print("search:", m.js(SEARCH))
    for i in range(6):
        time.sleep(2)
        state = json.loads(m.js(STATE))
    try:
        tabs = m.js("return (async () => { const r = await window.__astraHost.Tabs.list({ request_id: 'probe' }); return JSON.stringify((r.tabs || []).map((t) => t.url)); })()")
        state["shellTabs"] = tabs
    except Exception as e:
        state["shellTabs"] = f"ERR {e}"
    print(f"t+{(i + 1) * 2}s:", json.dumps(state))

    try:
        shot = m.cmd("WebDriver:TakeScreenshot", {})
        with open(os.path.join(outdir, "after.png"), "wb") as f:
            f.write(base64.b64decode(shot["value"]))
        print("screenshot ok")
    except Exception as e:
        print("screenshot ERR", e)

    proc.terminate()
    return 0


sys.exit(main())
