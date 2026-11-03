"""Tabs probe: a new tab, a search in it, and switching back.

Usage: python3 tools/marionette-probe/tabs-probe.py <profile-dir> <out-dir>
"""
import json
import os
import socket
import subprocess
import sys
import time

HOST, PORT = "127.0.0.1", 2828
FIREFOX = "engine/obj-astra-linux/dist/bin/firefox"
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


SEARCH_ADDRESS = js("""
  if (!d) return 'no doc';
  const input = d.querySelector('.address-field input');
  const form = input && input.closest('form');
  if (!input || !form) return 'no address field';
  input.focus();
  input.value = 'hello world';
  input.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
  form.dispatchEvent(new d.defaultView.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  return 'ok';
""")

NEW_TAB = js("""
  if (!d) return 'no doc';
  const b = d.querySelector('button.new-tab') || d.querySelector('button.space-new-tab');
  if (!b) return 'no new tab button';
  b.click();
  return 'ok';
""")

TAB_ROWS = js("""
  if (!d) return null;
  return JSON.stringify([...d.querySelectorAll('[data-astra-tab-id]')].map((r) => r.getAttribute('data-astra-tab-id')));
""")

SELECT_TAB = lambda n: js(f"""
  if (!d) return 'no doc';
  const rows = [...d.querySelectorAll('[data-astra-tab-id]')];
  const row = rows[{n}];
  if (!row) return 'no row';
  row.click();
  return 'ok';
""")

SET_ADDRESS = lambda value: js(f"""
  if (!d) return 'no doc';
  const input = d.querySelector('.address-field input');
  const form = input && input.closest('form');
  if (!input || !form) return 'no address field';
  input.focus();
  input.value = '{value}';
  input.dispatchEvent(new d.defaultView.Event('input', {{ bubbles: true }}));
  form.dispatchEvent(new d.defaultView.SubmitEvent('submit', {{ bubbles: true, cancelable: true }}));
  return 'ok';
""")

NEWTAB_SEARCH = js("""
  if (!d) return 'no doc';
  const input = d.querySelector('[data-astra-new-tab] .bar input') || d.querySelector('.dock .bar input');
  const form = input && input.closest('form');
  if (!input || !form) return 'no newtab field';
  input.focus();
  input.value = 'hello world';
  input.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
  return 'ok';
""")

NEWTAB_ROW = js("""
  if (!d) return null;
  const list = d.querySelector('#newtab-search-results');
  return list ? (list.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) : null;
""")

NEWTAB_SUBMIT = js("""
  if (!d) return 'no doc';
  const input = d.querySelector('[data-astra-new-tab] .bar input') || d.querySelector('.dock .bar input');
  const form = input && input.closest('form');
  if (!form) return 'no form';
  form.dispatchEvent(new d.defaultView.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  return 'ok';
""")

NEWTAB_ERROR = js("""
  if (!d) return null;
  const e = d.querySelector('[role="alert"]');
  return e ? (e.textContent || '').trim() : null;
""")

BROWSER = """return JSON.stringify((() => {
  const slot = document.querySelector('[data-astra-content]');
  const b = document.querySelector('browser[data-astra-browser]');
  const read = (fn) => { try { return fn(); } catch (e) { return 'ERR'; } };
  return {
    hasPage: slot ? slot.dataset.hasPage ?? null : null,
    loading: slot ? slot.dataset.loading ?? null : null,
    uri: b ? read(() => b.currentURI.spec) : null,
    relayError: read(() => window.__astraLastRelayError ?? null),
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
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
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

    failures = []

    print("search address:", m.js(SEARCH_ADDRESS))
    time.sleep(8)
    first = json.loads(m.js(BROWSER))
    print("tab1:", json.dumps(first))
    if "duckduckgo" not in (first.get("uri") or ""):
        failures.append("the address search did not load")

    print("new tab:", m.js(NEW_TAB))
    time.sleep(2)
    fresh = json.loads(m.js(BROWSER))
    print("tab2:", json.dumps(fresh))
    if fresh.get("hasPage") == "true":
        failures.append("a new tab kept the previous page on screen")

    print("tab2 address:", m.js(SET_ADDRESS("example.com")))
    time.sleep(6)
    moved = json.loads(m.js(BROWSER))
    print("tab2 moved:", json.dumps(moved))
    if "example.com" not in (moved.get("uri") or ""):
        failures.append("the second tab did not take its own address")

    rows = json.loads(m.js(TAB_ROWS) or "[]")
    print("rows:", rows)
    if len(rows) >= 1:
        print("switch back:", m.js(SELECT_TAB(0)))
        time.sleep(3)
        back = json.loads(m.js(BROWSER))
        print("tab1 again:", json.dumps(back))
        if "duckduckgo" not in (back.get("uri") or ""):
            failures.append("switching back did not restore the first tab's page")

    print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
