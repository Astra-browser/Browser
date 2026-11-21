"""Sidebar strip probe: a hidden column hands the page the window's gutter.

The owner reported a hairline down the left edge of a live page, with a strip
where the hidden column's card had been. The app's own page (New Tab) takes the
window gutter once the column is away; the native stage used to keep the 8px
gap beside the column, so the app's page card — edge, ring and drop — painted
a hairline 8px left of the real page. A peeking card then looked like it left
that strip behind when it went back.

The checks pin the geometry in three states: column in view, column away, and
peeking over a page. They also pin that New Tab lands on the same left edge as
the native page, so the two never trade an 8px jump.

Usage: python tools/marionette-probe/sidebar-strip-probe.py [outdir]
"""
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

astra_env.require()

HOST, PORT = "127.0.0.1", 2851
WEB_PORT = 8877
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY
GUTTER = 8

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Edge</title>
<style>
  html,body{margin:0;height:100%;background:#101011;color:#fff;font:14px system-ui}
  .edge{position:fixed;inset:0 auto 0 0;width:24px;background:#ff2d55}
  .box{position:absolute;inset:64px 40px 40px 48px;border:1px solid #444;border-radius:8px}
</style></head>
<body><div class="edge"></div><div class="box"></div></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


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


BOOTED = """return JSON.stringify((() => {
  const f = document.querySelector('.astra-frame');
  return { booted: f ? f.getAttribute('data-app-booted') : null };
})())"""

GEOM = """return JSON.stringify((() => {
  const f = document.querySelector('iframe[data-astra-app-frame]');
  const d = f && f.contentDocument;
  const frame = document.querySelector('.astra-frame');
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const content = document.querySelector('.astra-content');
  const deck = document.querySelector('#tabbrowser-tabbox');
  const cs = content ? getComputedStyle(content) : null;
  const aside = d ? d.querySelector('aside.browser-sidebar') : null;
  return {
    stage: document.documentElement.getAttribute('data-astra-stage'),
    hidden: frame && frame.getAttribute('data-astra-sidebar-hidden') === 'true',
    peek: frame && frame.getAttribute('data-astra-sidebar-peek') === 'true',
    content: rect(content),
    contentTop: cs ? cs.insetBlockStart : null,
    deck: rect(deck),
    app: d ? {
      aside: rect(aside),
      asideHidden: !!(aside && aside.hasAttribute('data-hidden')),
      asidePeek: !!(aside && aside.hasAttribute('data-peek')),
      card: rect(d.querySelector('.stage-card')),
      pane: rect(d.querySelector('.content-pane')),
    } : null,
  };
})())"""

SET_AUTO = """return (async () => {
  const r = await Services.astraHost.Settings.set({
    request_id: 'strip', key: 'ui.main-bar', value: 'auto',
  });
  return JSON.stringify(r);
})();"""

NAV = """return (async () => {
  const tabs = await Services.astraHost.Tabs.list({ request_id: 'strip' });
  const active = (tabs.tabs || []).find((t) => t.selected) || (tabs.tabs || [])[0];
  const r = await Services.astraHost.Navigation.loadURL({
    request_id: 'strip', astra_tab_id: active && active.astra_tab_id,
    url: '%s',
  });
  return JSON.stringify(r);
})();""" % f"http://127.0.0.1:{WEB_PORT}/edge"

NEW_TAB = """return (async () => {
  return JSON.stringify(await Services.astraHost.Tabs.create({
    request_id: 'strip', url: 'about:blank',
  }));
})();"""

TOGGLE = """const d = document.querySelector('iframe[data-astra-app-frame]')?.contentDocument;
if (!d) return 'no app';
const button = [...d.querySelectorAll('header button')]
  .find((b) => /toggle sidebar/i.test(b.getAttribute('aria-label') || ''));
if (!button) return 'no button';
button.click();
return 'ok';"""

EDGE = """const d = document.querySelector('iframe[data-astra-app-frame]')?.contentDocument;
if (!d) return 'no app';
d.defaultView.dispatchEvent(new d.defaultView.CustomEvent(
  'astra:sidebar-edge', { detail: { near: %s } }));
return 'ok';"""


def wait(fn, timeout=30, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "out", "probe-sidebar-strip")
    os.makedirs(outdir, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-strip-")
    server = http.server.ThreadingHTTPServer((HOST, WEB_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", profile, "-no-remote",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR, stdout=log, stderr=subprocess.STDOUT)
    failures = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + ("  " + detail if detail else ""), flush=True)
        if not ok:
            failures.append(name)

    m = None
    try:
        for _ in range(90):
            try:
                m = M(PORT)
                break
            except OSError:
                time.sleep(0.5)
        if m is None:
            print("SKIP: marionette did not open")
            return 2
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1200, "height": 820})
        wait(lambda: json.loads(m.js(BOOTED))["booted"] == "true", 90)
        time.sleep(1.5)
        m.js(SET_AUTO)
        time.sleep(0.5)
        m.js(NAV)
        wait(lambda: m.js("return document.documentElement.getAttribute('data-astra-stage');") == "page", 30)
        time.sleep(1.5)

        shown = json.loads(m.js(GEOM))
        once = shown["app"]["aside"]
        expected = round(once["x"] + once["w"] + GUTTER, 1)
        check("column in view: the page stands beside it",
              abs(shown["content"]["x"] - expected) <= 1,
              f"content={shown['content']['x']:.1f} expected={expected:.1f}")
        check("column in view: the card is under the page",
              abs(shown["app"]["card"]["x"] - shown["content"]["x"]) <= 0.5,
              f"card={shown['app']['card']['x']:.1f} content={shown['content']['x']:.1f}")
        check("column in view: the native deck shares the page's edge",
              abs(shown["deck"]["x"] - shown["content"]["x"]) <= 0.5,
              f"deck={shown['deck']['x']:.1f} content={shown['content']['x']:.1f}")

        check("hide toggles the column", m.js(TOGGLE) == "ok")
        changed = wait(lambda: json.loads(m.js(GEOM))["hidden"], 15)
        check("hidden column is reported to the shell", bool(changed))
        time.sleep(1.2)
        hidden = json.loads(m.js(GEOM))

        check("column away: the page takes the window gutter",
              abs(hidden["content"]["x"] - GUTTER) <= 0.5,
              f"content={hidden['content']['x']:.1f}")
        check("column away: the card no longer stands in the strip",
              abs(hidden["app"]["card"]["x"] - hidden["content"]["x"]) <= 0.5,
              f"card={hidden['app']['card']['x']:.1f} content={hidden['content']['x']:.1f}")
        check("column away: the native deck shares the page's edge",
              abs(hidden["deck"]["x"] - hidden["content"]["x"]) <= 0.5,
              f"deck={hidden['deck']['x']:.1f} content={hidden['content']['x']:.1f}")
        check("column away: the floating page bar lets the page reach the top",
              hidden["contentTop"] == "8px", f"top={hidden['contentTop']}")

        check("peek opens the card", m.js(EDGE % "true") == "ok")
        peeked = wait(lambda: json.loads(m.js(GEOM))["peek"], 10)
        check("peeking card is reported to the shell", bool(peeked))
        time.sleep(1)
        over = json.loads(m.js(GEOM))
        check("peek does not move the page",
              abs(over["content"]["x"] - hidden["content"]["x"]) <= 0.5,
              f"content={over['content']['x']:.1f}")
        check("peek brings the card out over the page",
              abs(over["app"]["aside"]["x"] - GUTTER) <= 0.5,
              f"aside={over['app']['aside']['x']:.1f}")

        check("peek releases", m.js(EDGE % "false") == "ok")
        wait(lambda: not json.loads(m.js(GEOM))["peek"], 10)
        time.sleep(1.4)
        after = json.loads(m.js(GEOM))
        check("after the card goes back: the page is still on the gutter",
              abs(after["content"]["x"] - GUTTER) <= 0.5,
              f"content={after['content']['x']:.1f}")
        check("after the card goes back: no card edge left in the strip",
              abs(after["app"]["card"]["x"] - after["content"]["x"]) <= 0.5,
              f"card={after['app']['card']['x']:.1f} content={after['content']['x']:.1f}")

        m.js(NEW_TAB)
        wait(lambda: m.js("return document.documentElement.getAttribute('data-astra-stage');") == "app", 20)
        time.sleep(1)
        home = json.loads(m.js(GEOM))
        check("New Tab lands on the same gutter as a page",
              home["app"]["pane"] is not None
              and abs(home["app"]["pane"]["x"] - GUTTER) <= 0.5,
              f"pane={home['app']['pane']['x']:.1f}" if home["app"]["pane"] else "no pane")

        print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures), flush=True)
        return 0 if not failures else 1
    finally:
        try:
            if m is not None:
                m.cmd("WebDriver:Quit", {})
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
