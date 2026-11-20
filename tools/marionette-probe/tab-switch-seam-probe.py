"""Tab-switch seam probe: New Tab <-> page must not flash a load state or slide.

Checks the two defects reported on 2026-11-19:

  1. Switching to a New Tab painted a black stage with "Loading" at its
     top-left for a frame (LazyView resetting its resolved view on remount,
     and the New Tab search field being keyed by the active tab).
  2. Switching back to a page made the page slide up 40px (the stage's top
     edge transitioned while the bar changed from its New Tab row to a
     floating overlay).

Usage: python tools/marionette-probe/tab-switch-seam-probe.py <profile> <out>
"""
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
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


STAGE = """return JSON.stringify((() => {
  const slot = document.querySelector('[data-astra-content]');
  const cs = slot ? getComputedStyle(slot) : null;
  return {
    hasPage: slot ? slot.dataset.hasPage ?? null : null,
    loading: slot ? slot.dataset.loading ?? null : null,
    top: cs ? cs.insetBlockStart : null,
    transition: cs ? cs.transitionProperty : null,
    duration: cs ? cs.transitionDuration : null,
  };
})())"""

NEW_TAB = js("""
  if (!d) return 'no doc';
  const b = d.querySelector('button.new-tab') || d.querySelector('button.space-new-tab');
  if (!b) return 'no new tab button';
  b.click();
  return 'ok';
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

LOAD_STATES = js("""
  if (!d) return JSON.stringify([]);
  const seen = [...d.querySelectorAll('.load-state')]
    .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  return JSON.stringify(seen);
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
    # Let the shell boot the app frame and seed the New Tab.
    for _ in range(120):
        if m.js(js("return d ? 'ok' : 'no'")) == "ok":
            break
        time.sleep(0.25)
    time.sleep(8)

    failures = []
    stage = lambda: json.loads(m.js(STAGE))

    def wait_for(predicate, seconds):
        for _ in range(seconds * 4):
            now = stage()
            if predicate(now):
                return now
            time.sleep(0.25)
        return stage()

    print("stage at start:", json.dumps(stage()))
    print("address:", m.js(SET_ADDRESS("example.com")))
    loaded = wait_for(lambda s: s.get("hasPage") == "true" and s.get("loading") is None, 40)
    print("page:", json.dumps(loaded))
    if loaded.get("hasPage") != "true":
        failures.append("example.com never took the stage")
    props = [p.strip() for p in (loaded.get("transition") or "").split(",")]
    durations = [d.strip() for d in (loaded.get("duration") or "").split(",")]
    if ("all" in props or "inset-block-start" in props) and any(
        d not in ("0s", "0ms") for d in durations
    ):
        failures.append("the stage still transitions its top edge (the page slides)")

    # Switch to a New Tab and watch the first frames for the load state.
    print("new tab:", m.js(NEW_TAB))
    seen_states = set()
    first_top = []
    for _ in range(60):
        seen_states.update(json.loads(m.js(LOAD_STATES)))
        first_top.append(stage().get("top"))
        time.sleep(0.008)
    print("new tab load states:", sorted(seen_states))
    print("new tab stage tops:", sorted(set(t for t in first_top if t)))
    if seen_states:
        failures.append("the New Tab painted a load state: " + "; ".join(sorted(seen_states)))
    fresh = wait_for(lambda s: s.get("hasPage") != "true", 5)
    if fresh.get("hasPage") == "true":
        failures.append("the New Tab kept the page on the stage")

    # Switch back: the page must land at its final top edge, not travel to it.
    print("back:", m.js(SELECT_TAB(0)))
    tops = []
    for _ in range(40):
        tops.append(stage().get("top"))
        time.sleep(0.008)
    print("page stage tops:", sorted(set(t for t in tops if t)))
    if any(t not in ("8px", None, "") for t in tops):
        failures.append("the page travelled into place: " + ", ".join(sorted(set(tops))))
    back = wait_for(lambda s: s.get("hasPage") == "true", 10)
    print("page again:", json.dumps(back))
    if back.get("hasPage") != "true":
        failures.append("switching back did not restore the page")

    print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
