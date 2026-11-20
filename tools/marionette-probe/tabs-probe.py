"""Tabs probe: a new tab, a search in it, and switching back.

Usage: python3 tools/marionette-probe/tabs-probe.py <profile-dir> <out-dir>
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2828
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY
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
  (row.querySelector('button.tab-open') || row).click();
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

NEWTAB_ROW = js(r"""
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
  // The selected native tab is the authority; the slot marker only exists on
  // the Linux slot path. Fall back to the first browser for a plain build.
  let b = null;
  try { b = gBrowser?.selectedBrowser; } catch (e) {}
  if (!b) b = document.querySelector('browser[data-astra-browser]')
    || document.querySelector('.astra-content browser')
    || document.querySelector('browser');
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
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(os.path.abspath(FIREFOX)),
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

    def state():
        return json.loads(m.js(BROWSER))

    def wait_for(predicate, seconds):
        """Network speed varies here, so wait for the real load to settle
        instead of sleeping a guessed amount. Loading is cleared from the
        content browser's own document load, not the model's instant commit."""
        for _ in range(seconds * 4):
            now = state()
            if predicate(now):
                return now
            time.sleep(0.25)
        return state()

    def host_of(uri):
        """Host of a URI, without a scheme or path."""
        text = str(uri or "")
        if "//" not in text:
            return ""
        return text.split("//", 1)[1].split("/", 1)[0].lower()

    # The shipped default engine is Google, and this network sometimes answers
    # an automated query with a consent/CAPTCHA page. Either way the address
    # was submitted to a real engine; the page's own content is not this
    # probe's subject.
    SEARCH_HOSTS = ("google.", "duckduckgo.", "bing.", "brave.", "ecosia.", "startpage.")

    print("search address:", m.js(SEARCH_ADDRESS))
    first = wait_for(
        lambda s: s.get("loading") is None and host_of(s.get("uri")) != "", 30)
    first_host = host_of(first.get("uri"))
    print("tab1:", json.dumps(first))
    if not any(engine in first_host for engine in SEARCH_HOSTS):
        failures.append("the address search did not reach a search engine")
    if first.get("loading") is not None:
        failures.append("the search page never finished loading")

    print("new tab:", m.js(NEW_TAB))
    fresh = wait_for(lambda s: s.get("hasPage") != "true", 10)
    print("tab2:", json.dumps(fresh))
    if fresh.get("hasPage") == "true":
        failures.append("a new tab kept the previous page on screen")

    print("tab2 address:", m.js(SET_ADDRESS("google.com")))
    moved = wait_for(
        lambda s: s.get("loading") is None and "google.com" in (s.get("uri") or ""), 30)
    print("tab2 moved:", json.dumps(moved))
    if "google.com" not in (moved.get("uri") or ""):
        failures.append("the second tab did not take its own address")

    rows = json.loads(m.js(TAB_ROWS) or "[]")
    print("rows:", rows)
    if len(rows) >= 1:
        print("switch back:", m.js(SELECT_TAB(0)))
        # The first tab kept its own browser, so its page is already there:
        # switching back must not reload it or show a blank stage.
        back = wait_for(
            lambda s: s.get("hasPage") == "true" and host_of(s.get("uri")) == first_host, 10)
        print("tab1 again:", json.dumps(back))
        # The first tab's page may have redirected on its own in the meantime
        # (Google turns an automated query into a consent/CAPTCHA page), so the
        # guarantee is that it still holds its own page on its own host, not a
        # blank stage and not the second tab's site.
        if back.get("hasPage") != "true" or host_of(back.get("uri")) != first_host:
            failures.append("switching back did not restore the first tab's page")

    print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
