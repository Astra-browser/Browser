"""Search probe: typing words into the address field must become a search.

Usage: python3 tools/marionette-probe/search-probe.py <profile-dir> <out-dir>
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


TYPE_AND_SUBMIT = js("""
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

FOCUS_FIELD = js("""
  if (!d) return 'no doc';
  const input = d.querySelector('.address-field input');
  if (!input) return 'no address field';
  input.focus();
  return 'ok';
""")

BLUR = js("""
  if (!d) return 'no doc';
  const input = d.querySelector('.address-field input');
  if (input) input.blur();
  return 'ok';
""")

FIELD = js("""
  if (!d) return null;
  const input = d.querySelector('.address-field input');
  return input ? input.value : null;
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
  const text = list ? (list.textContent || '').replace(/\s+/g, ' ').trim() : '';
  return JSON.stringify({ row: /Search DuckDuckGo/.test(text), text: text.slice(0, 120) });
""")

NEWTAB_RUN = js("""
  if (!d) return 'no doc';
  const input = d.querySelector('[data-astra-new-tab] .bar input') || d.querySelector('.dock .bar input');
  const form = input && input.closest('form');
  if (!form) return 'no form';
  form.dispatchEvent(new d.defaultView.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  return 'ok';
""")

TAB_URL = js("""
  if (!d) return null;
  const row = d.querySelector('[data-astra-tab-id]');
  const el = row && (row.querySelector('.tab-url') || row.querySelector('.tab-label') || row);
  return el ? (el.textContent || '').trim() : null;
""")


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
    print("field before:", m.js(FIELD))
    print("submit:", m.js(TYPE_AND_SUBMIT))
    time.sleep(3)
    print("blur:", m.js(BLUR))
    time.sleep(1)
    # Focusing the field reveals the whole address (the resting form shows the
    # host only).
    m.js(FOCUS_FIELD)
    time.sleep(0.5)
    field = m.js(FIELD)
    row = m.js(TAB_URL)
    print("field after:", field)
    print("tab row:", row)
    if not field or "duckduckgo.com" not in field:
        failures.append("the address field did not resolve to a search URL")
    if "q=hello%20world" not in (field or ""):
        failures.append("the query was not encoded into the URL")

    # New Tab: the same words must offer a web search and run it.
    print("newtab.reload:", m.js("return (() => {" + "const f=document.querySelector('iframe[data-astra-app-frame]');f.contentWindow.location.reload();return 'ok';" + "})()"))
    time.sleep(10)
    print("newtab.type:", m.js(NEWTAB_SEARCH))
    time.sleep(2)
    row = json.loads(m.js(NEWTAB_ROW))
    print("newtab.row:", json.dumps(row))
    if not row.get("row"):
        failures.append("the New Tab offered no web search")
    print("newtab.run:", m.js(NEWTAB_RUN))
    time.sleep(3)
    m.js(FOCUS_FIELD)
    time.sleep(0.5)
    field = m.js(FIELD)
    print("newtab.field:", field)
    if not field or "duckduckgo.com" not in field:
        failures.append("the New Tab search did not run")

    print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
