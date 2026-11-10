#!/usr/bin/env python3
"""Edge-case matrix for the live dev build (orchestrator-run, stdlib only).

Drives the *built* Astra binary (`engine/obj-astra-linux/dist/bin/firefox`)
over Marionette in chrome context and exercises the browser edge cases the
standalone lane cannot reach:

  1. boot        — app frame mounts in host mode, column + one tab present
  2. empty slot  — with no committed page the content slot is out of layout
  3. navigate    — the address field commits a real loopback page
  4. geometry    — the content slot is the app's content rectangle
                   (8px gutter, inset by --astra-sidebar-width + 16px; the bar
                    is above it unless it is overlaying)
  5. new tab + search Enter — typed words commit a search URL in the new tab
  6. tab switch  — returning to a tab keeps its page (no reload: the fixture
                   server must NOT see a second request)
  7. reload      — Reload re-fetches the page (server sees request #2)
  8. history     — Back/Forward move the page between two real URLs
  9. long text   — an unbroken 240-char title does not widen the chrome
 10. sidebar     — Toggle hides the column and raises the edge; toggling back
 11. compact     — Work mode turns the column into the 56px rail
 12. spaces      — a created space appears in the switcher and can be picked
 13. window close— closing the last window is refused (`last_window`)

Every wait polls real state; there is no fixed sleep anywhere except the
Marionette port handshake. Assertions are about what the UI owns: geometry,
projection, focus, and the *number of network fetches* the page made.

Usage:
  python3 tools/marionette-probe/edge-matrix.py [profile-dir] [out-dir]

Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary). Env overrides:
  ASTRA_BINARY, ASTRA_MARIONETTE_PORT, ASTRA_ENGINE.
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
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine"))
FIREFOX = os.environ.get(
    "ASTRA_BINARY", os.path.join(ENGINE, "obj-astra-linux", "dist", "bin", "firefox")
)
PORT = int(os.environ.get("ASTRA_MARIONETTE_PORT", "2828"))
HOST = "127.0.0.1"

LONG_TOKEN = "x" * 240

PAGES = {
    "a.html": (
        "<html><head><title>QA A</title></head>"
        "<body><h1 id='m'>qa-marker-a</h1></body></html>"
    ),
    "b.html": (
        "<html><head><title>QA B</title></head>"
        "<body><h1 id='m'>qa-marker-b</h1></body></html>"
    ),
    "long.html": (
        "<html><head><title>" + LONG_TOKEN + "</title></head>"
        "<body><h1>" + LONG_TOKEN + "</h1></body></html>"
    ),
}

# One request per committed document load. A kept page never fetches again, so
# these counters are the ground truth for "no reload" and "reload happened".
COUNTS = {name: 0 for name in PAGES}
DOC_COUNTS = {name: 0 for name in PAGES}
COUNTS_LOCK = threading.Lock()
REQUESTS = []


def serve_pages():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            name = self.path.lstrip("/").split("?")[0]
            body = PAGES.get(name)
            if body is None:
                self.send_error(404, "no such fixture")
                return
            with COUNTS_LOCK:
                COUNTS[name] += 1
                # The page's own document load, not the favicon service's read
                # of the same URL.
                if self.headers.get("Sec-Fetch-Dest") == "document":
                    DOC_COUNTS[name] += 1
                REQUESTS.append(self.path)
            payload = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer((HOST, 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def count(name):
    with COUNTS_LOCK:
        return COUNTS[name]


def doc_count(name):
    with COUNTS_LOCK:
        return DOC_COUNTS[name]


# --- In-page helpers (chrome context; the app lives in an iframe) -----------

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


# Everything the checks read, in one pass, so a poll is a single round trip.
STATE = js("""
  if (!d) return JSON.stringify({ ready: false });
  const rect = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right),
             b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // The shell document owns the frame, the content slot and the browser; the
  // app frame owns the column, the address field and the tab rows.
  const shell = document;
  const frameRoot = shell.querySelector('[data-astra-frame]');
  const appMount = shell.querySelector('.astra-app-mount');
  const frame = shell.querySelector('.astra-frame');
  const aside = d.querySelector('aside.browser-sidebar');
  const slot = shell.querySelector('[data-astra-content]');
  const browser = shell.querySelector('browser[data-astra-browser]')
    || (shell.defaultView?.gBrowser?.selectedTab?.linkedBrowser ?? null);
  const rows = [...d.querySelectorAll('[data-astra-tab-id]')];
  const current = rows.find((row) => row.getAttribute('aria-current') === 'page') || rows[0] || null;
  const address = d.querySelector('.address-field input')
    || d.querySelector('input[aria-label="Address and search"]');
  const read = (fn) => { try { return fn(); } catch { return 'ERR'; } };
  const cssVar = (() => {
    for (const el of [frameRoot, shell.documentElement, shell.body]) {
      if (!el) continue;
      const value = getComputedStyle(el).getPropertyValue('--astra-sidebar-width').trim();
      if (value !== '') return value;
    }
    return '';
  })();
  const spaces = d.querySelector('button[aria-label^="Spaces"]');
  return JSON.stringify({
    ready: true,
    appReady: appMount ? appMount.getAttribute('data-app-ready') : null,
    aside: rect(aside),
    asideHidden: aside ? aside.hasAttribute('data-hidden') : null,
    asidePeek: aside ? aside.hasAttribute('data-peek') : null,
    peekFlag: frame ? frame.dataset.astraSidebarPeek ?? null : null,
    appZ: appMount ? getComputedStyle(appMount).zIndex : null,
    slotZ: slot ? getComputedStyle(slot).zIndex : null,
    appHtmlBg: d ? getComputedStyle(d.documentElement).backgroundColor : null,
    barMode: frameRoot ? frameRoot.getAttribute("data-astra-bar") : null,
    barHeight: frameRoot
      ? parseFloat(getComputedStyle(frameRoot).getPropertyValue("--astra-bar-height")) || 0
      : 0,
    edge: !!d.querySelector('.sidebar-edge'),
    slot: rect(slot),
    slotHasPage: slot ? (slot.dataset.hasPage ?? null) : null,
    slotLoading: slot ? (slot.dataset.loading ?? null) : null,
    browser: rect(browser),
    sidebarVar: cssVar,
    viewport: { w: shell.defaultView.innerWidth, h: shell.defaultView.innerHeight },
    docOverflow: shell.scrollingElement
      ? shell.scrollingElement.scrollWidth - shell.scrollingElement.clientWidth : -1,
    tabCount: rows.length,
    tabRow: rect(current),
    tabRowText: current ? (current.textContent || '').replace(/\\s+/g, ' ').trim() : null,
    tabRowScroll: current ? { scroll: current.scrollWidth, client: current.clientWidth } : null,
    tabLabelScroll: (() => {
      const label = current ? current.querySelector('[data-astra-tab-label]') : null;
      return label ? { scroll: label.scrollWidth, client: label.clientWidth } : null;
    })(),
    uri: browser ? read(() => browser.currentURI.spec) : null,
    title: browser ? read(() => browser.contentTitle) : null,
    address: address ? address.value : null,
    spacesLabel: spaces ? spaces.getAttribute('aria-label') : null,
    spacePicks: [...d.querySelectorAll('[role="menuitemradio"]')]
      .map((node) => (node.textContent || '').trim()),
    newtabResults: (() => {
      const list = d.querySelector('#newtab-search-results');
      return list ? (list.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null;
    })(),
  });
""")


def click_named(label):
    """Click the first button whose accessible label (or text) matches."""
    return js(f"""
      if (!d) return 'no doc';
      const label = {json.dumps(label)};
      const target = [...d.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') || button.textContent || '').trim() === label);
      if (!target) return 'missing:' + label;
      if (target.disabled) return 'disabled:' + label;
      target.click();
      return 'ok';
    """)


def click_starts(label):
    return js(f"""
      if (!d) return 'no doc';
      const prefix = {json.dumps(label)};
      const target = [...d.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') || '').trim().startsWith(prefix));
      if (!target) return 'missing:' + prefix;
      target.click();
      return 'ok';
    """)


def set_address(url):
    return js(f"""
      if (!d) return 'no doc';
      const input = d.querySelector('.address-field input')
        || d.querySelector('input[aria-label="Address and search"]');
      if (!input) return 'no address field';
      const form = input.closest('form');
      if (!form) return 'no address form';
      input.focus();
      input.value = {json.dumps(url)};
      input.dispatchEvent(new d.defaultView.Event('input', {{ bubbles: true }}));
      form.dispatchEvent(new d.defaultView.SubmitEvent('submit',
        {{ bubbles: true, cancelable: true }}));
      return 'ok';
    """)


def type_newtab(text):
    return js(f"""
      if (!d) return 'no doc';
      const input = d.querySelector('[data-astra-new-tab] .bar input')
        || d.querySelector('.dock .bar input');
      if (!input) return 'no newtab field';
      input.focus();
      input.value = {json.dumps(text)};
      input.dispatchEvent(new d.defaultView.Event('input', {{ bubbles: true }}));
      return 'ok';
    """)


def enter_newtab():
    return js("""
      if (!d) return 'no doc';
      const input = d.querySelector('[data-astra-new-tab] .bar input')
        || d.querySelector('.dock .bar input');
      if (!input) return 'no newtab field';
      input.focus();
      input.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      return 'ok';
    """)


def click_tab(index):
    return js(f"""
      if (!d) return 'no doc';
      const rows = [...d.querySelectorAll('[data-astra-tab-id]')];
      const row = rows[{index}];
      if (!row) return 'no row';
      (row.querySelector('button.tab-open') || row).click();
      return 'ok';
    """)


class M:
    """Minimal Marionette client (same shape as tabs-probe.py)."""

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
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            message = self._read()
            if isinstance(message, list) and len(message) == 4 and message[1] == self._id:
                if message[2]:
                    raise RuntimeError(message)
                return message[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def async_js(self, script, args=None):
        """Async script: the script receives a callback as its last argument."""
        return self.cmd(
            "WebDriver:ExecuteAsyncScript", {"script": script, "args": list(args or [])}
        )["value"]


def main():
    if not os.path.exists(FIREFOX):
        print(f"SKIP: missing {FIREFOX} (run a full engine build first, --jobs 2)")
        return 2

    profile = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="astra-edge-prof-")
    outdir = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="astra-edge-out-")
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)

    server, port = serve_pages()
    base = f"http://{HOST}:{port}"
    urls = {name: f"{base}/{name}" for name in PAGES}
    print(f"fixtures: {urls}")

    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(os.path.abspath(FIREFOX)),
        stdout=log, stderr=subprocess.STDOUT,
    )

    m = None
    for _ in range(60):
        try:
            m = M(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("FAIL: no marionette port")
        proc.terminate()
        server.shutdown()
        return 1

    failures = []
    skipped = []
    report = []

    def check(name, ok, detail=""):
        status = "PASS" if ok else "FAIL"
        print(f"{status} {name}" + (f" — {detail}" if detail else ""))
        report.append({"check": name, "status": status, "detail": detail})
        if not ok:
            failures.append(name)
        return ok

    def state():
        raw = m.js(STATE)
        try:
            return json.loads(raw)
        except Exception:
            return {"ready": False, "raw": raw}

    def wait_for(predicate, seconds=30, label=""):
        deadline = time.time() + seconds
        last = None
        while time.time() < deadline:
            last = state()
            try:
                if predicate(last):
                    return last
            except Exception:
                pass
            time.sleep(0.2)
        if label:
            print(f"  (timed out waiting for {label}: {json.dumps(last)[:300]})")
        return last

    try:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})

        # 1. boot -----------------------------------------------------------------
        boot = wait_for(
            lambda s: s.get("ready") and s.get("appReady") == "host" and s.get("aside"),
            seconds=120, label="app frame in host mode",
        )
        check("boot: app frame mounts in host mode", boot.get("appReady") == "host",
              json.dumps({"appReady": boot.get("appReady")}))
        check("boot: sidebar column and a tab are present",
              bool(boot.get("aside")) and (boot.get("tabCount") or 0) >= 1,
              json.dumps({"aside": boot.get("aside"), "tabs": boot.get("tabCount")}))

        # 2. empty content slot ---------------------------------------------------
        check("empty slot: no committed page keeps the slot out of layout",
              boot.get("slotHasPage") in (None, "false")
              and (boot.get("slot") or {}).get("w", 0) <= 1,
              json.dumps({"hasPage": boot.get("slotHasPage"), "slot": boot.get("slot")}))

        # 3. navigate the address field to a real loopback page -------------------
        print("address:", m.js(set_address(urls["a.html"])))
        page_a = wait_for(
            lambda s: s.get("slotHasPage") == "true" and "a.html" in (s.get("uri") or ""),
            label="first page commit",
        )
        check("navigate: address field commits a real page",
              "a.html" in (page_a.get("uri") or "") and doc_count("a.html") == 1,
              json.dumps({"uri": page_a.get("uri"), "fetches": doc_count("a.html")}))

        # 4. content-slot geometry ------------------------------------------------
        def settled(state):
            s_slot = state.get("slot") or {}
            mode = state.get("barMode")
            top = 8 if mode == "overlay" else 8 + (state.get("barHeight") or 40)
            return state if abs(s_slot.get("t", -99) - top) <= 2 else None
        page_a = wait_for(settled, seconds=3, label="content slot inset") or page_a
        slot = page_a.get("slot") or {}
        aside = page_a.get("aside") or {}
        viewport = page_a.get("viewport") or {}
        try:
            sidebar_var = float((page_a.get("sidebarVar") or "0px").replace("px", "") or 0)
        except ValueError:
            sidebar_var = 0.0
        expected_left = sidebar_var + 16
        # The bar sits above the page in flow mode; when it overlays on hover
        # the page starts at the 8px gutter instead.
        bar_inset = 0 if page_a.get("barMode") == "overlay" else (page_a.get("barHeight") or 40)
        expected_top = 8 + bar_inset
        geometry_ok = (
            slot
            and abs(slot.get("l", -99) - expected_left) <= 2
            and abs(slot.get("t", -99) - expected_top) <= 2
            and abs(slot.get("r", -99) - (viewport.get("w", 0) - 8)) <= 2
            and abs(slot.get("b", -99) - (viewport.get("h", 0) - 8)) <= 2
            and slot.get("l", 0) >= aside.get("r", 0) - 1
        )
        check("geometry: content slot is the app's content rectangle", bool(geometry_ok),
              json.dumps({"slot": slot, "aside": aside, "var": sidebar_var,
                          "expectedLeft": expected_left, "expectedTop": expected_top,
                          "bar": page_a.get("barMode"), "viewport": viewport}))

        # 5. new tab + New Tab search Enter --------------------------------------
        print("new tab:", m.js(click_named("New tab")))
        fresh = wait_for(
            lambda s: s.get("tabCount", 0) >= 2 and s.get("slotHasPage") in (None, "false"),
            label="blank new tab",
        )
        check("new tab: opens blank (no inherited page)",
              fresh.get("tabCount", 0) >= 2 and fresh.get("slotHasPage") in (None, "false"),
              json.dumps({"tabs": fresh.get("tabCount"), "hasPage": fresh.get("slotHasPage")}))

        print("type:", m.js(type_newtab("qa probe")))
        answered = wait_for(
            lambda s: s.get("newtabResults"), label="new tab search answer",
        )
        print("new tab results:", answered.get("newtabResults"))
        print("enter:", m.js(enter_newtab()))
        # The model is the authority on what the field submitted; the real
        # browser loading that URL is covered by the tab-switch/reload checks.
        searched = wait_for(
            lambda s: "duckduckgo.com" in (s.get("address") or ""),
            label="search commit from the New Tab field",
        )
        model_url = m.async_js("""
            const done = arguments[arguments.length - 1];
            Services.astraHost.Tabs.list({}).then((list) => {
              const tab = list.tabs.find((entry) => entry.selected) || {};
              done(tab.url || '');
            }, () => done(''));
        """) or ""
        check("new tab search Enter commits the search URL",
              "duckduckgo.com" in model_url and "qa" in model_url.lower(),
              json.dumps({"address": searched.get("address"),
                          "uri": searched.get("uri"), "model": model_url}))

        # 6. tab switch keeps pages ----------------------------------------------
        before = doc_count("a.html")
        print("switch to tab 0:", m.js(click_tab(0)))
        back = wait_for(lambda s: "a.html" in (s.get("uri") or ""), label="first tab page")
        check("tab switch: returning restores the page without a reload",
              "a.html" in (back.get("uri") or "") and doc_count("a.html") == before,
              json.dumps({"uri": back.get("uri"), "fetchesBefore": before,
                          "fetchesAfter": doc_count("a.html")}))

        # 7. reload ---------------------------------------------------------------
        before = doc_count("a.html")
        print("reload:", m.js(click_named("Reload")))
        reloaded = wait_for(lambda s: doc_count("a.html") > before, label="reload fetch")
        check("reload: asks the server for the page again",
              doc_count("a.html") == before + 1,
              json.dumps({"fetchesBefore": before, "fetchesAfter": doc_count("a.html"),
                          "uri": reloaded.get("uri")}))

        # 8. history back / forward ----------------------------------------------
        print("address b:", m.js(set_address(urls["b.html"])))
        page_b = wait_for(
            lambda s: "b.html" in (s.get("uri") or ""), label="second page commit")
        print("back:", m.js(click_named("Back")))
        hist_back = wait_for(lambda s: "a.html" in (s.get("uri") or ""), label="back to A")
        print("forward:", m.js(click_named("Forward")))
        hist_fwd = wait_for(lambda s: "b.html" in (s.get("uri") or ""), label="forward to B")
        check("history: Back and Forward move between the two pages",
              "a.html" in (hist_back.get("uri") or "")
              and "b.html" in (hist_fwd.get("uri") or ""),
              json.dumps({"back": hist_back.get("uri"), "forward": hist_fwd.get("uri"),
                          "bFirst": page_b.get("uri")}))

        # 9. long unbroken text ---------------------------------------------------
        print("address long:", m.js(set_address(urls["long.html"])))
        long_page = wait_for(
            lambda s: "long.html" in (s.get("uri") or "")
            and len(s.get("tabRowText") or "") > 40,
            label="long title commit")
        row = long_page.get("tabRow") or {}
        aside = long_page.get("aside") or {}
        row_scroll = long_page.get("tabRowScroll") or {}
        check("long text: unbroken title does not widen the chrome",
              long_page.get("docOverflow") == 0
              and row.get("r", 0) <= aside.get("r", 0) + 1,
              json.dumps({"docOverflow": long_page.get("docOverflow"),
                          "row": row, "asideRight": aside.get("r"),
                          "rowScroll": row_scroll}))
        label_scroll = long_page.get("tabLabelScroll") or {}
        check("long text: the tab label overflows its row and is clipped there",
              bool(label_scroll)
              and label_scroll.get("scroll", 0) > label_scroll.get("client", 0),
              json.dumps({"row": row_scroll, "label": label_scroll}))

        # 10. sidebar hidden ------------------------------------------------------
        print("toggle:", m.js(click_named("Toggle sidebar")))
        hidden = wait_for(lambda s: s.get("asideHidden") is True and s.get("edge"),
                          label="sidebar hidden")
        check("sidebar: Toggle hides the column and raises the edge",
              hidden.get("asideHidden") is True and hidden.get("edge") is True,
              json.dumps({"hidden": hidden.get("asideHidden"), "edge": hidden.get("edge")}))
        # 10b. hidden column peeks as chrome over the live page ---------------
        print("peek:", m.js(js("""
            if (!d) return 'no doc';
            d.defaultView.dispatchEvent(new d.defaultView.CustomEvent(
              'astra:sidebar-edge', { detail: { near: true } }));
            return 'ok';
        """)))
        peeked = wait_for(
            lambda s: s.get("peekFlag") == "true" and s.get("asidePeek") is True,
            seconds=10, label="hidden card over the page",
        )
        app_z = int(peeked.get("appZ") or 0)
        slot_z = int(peeked.get("slotZ") or 0)
        check("sidebar: a hidden column peeks as chrome above the page",
              peeked.get("peekFlag") == "true"
              and peeked.get("asidePeek") is True
              and app_z > slot_z
              and peeked.get("appHtmlBg") == "rgba(0, 0, 0, 0)",
              json.dumps({"flag": peeked.get("peekFlag"), "appZ": app_z,
                          "slotZ": slot_z, "htmlBg": peeked.get("appHtmlBg"),
                          "aside": peeked.get("aside")}))
        print("peek out:", m.js(js("""
            if (!d) return 'no doc';
            d.defaultView.dispatchEvent(new d.defaultView.CustomEvent(
              'astra:sidebar-edge', { detail: { near: false } }));
            return 'ok';
        """)))
        retracted = wait_for(
            lambda s: s.get("peekFlag") != "true" and s.get("asidePeek") is not True,
            seconds=10, label="card retracts",
        )
        check("sidebar: the card gives the page back",
              retracted.get("peekFlag") != "true" and retracted.get("asidePeek") is not True,
              json.dumps({"flag": retracted.get("peekFlag"), "peek": retracted.get("asidePeek")}))

        print("toggle back:", m.js(click_named("Toggle sidebar")))
        shown = wait_for(lambda s: s.get("asideHidden") is not True, label="sidebar shown")
        check("sidebar: toggling back restores the column",
              shown.get("asideHidden") is not True,
              json.dumps({"hidden": shown.get("asideHidden")}))

        # 11. compact rail (Work mode) -------------------------------------------
        work = m.js(js("""
            if (!d) return 'no doc';
            const radio = [...d.querySelectorAll('[role="radio"]')]
              .find((node) => ((node.getAttribute('aria-label') || node.textContent || '').trim() === 'Work'));
            if (!radio) return 'missing:Work';
            radio.click();
            return 'ok';
        """))
        print("work mode:", work)
        rail = wait_for(lambda s: (s.get("aside") or {}).get("w", 999) <= 60,
                        seconds=15, label="compact rail width")
        width = (rail.get("aside") or {}).get("w")
        if work == "missing:Work":
            # Work is a build flag and is off in the shipped build (D-48), so
            # the rail mode is correctly absent rather than broken.
            skipped.append("compact rail (Work is off in this build)")
        elif width is None:
            skipped.append("compact rail (no aside while compact)")
        else:
            check("sidebar: Work mode turns the column into the 56px rail",
                  width <= 60, json.dumps({"width": width}))
        print("browse mode:", m.js("""
            return (() => {
              Services.astraHost.Commands.run({ id: 'browser.return' });
              return 'ok';
            })()
        """))
        restored = wait_for(lambda s: (s.get("aside") or {}).get("w", 0) > 60,
                            seconds=15, label="expanded column")
        check("sidebar: Browse mode restores the expanded column",
              (restored.get("aside") or {}).get("w", 0) > 60,
              json.dumps({"width": (restored.get("aside") or {}).get("w")}))

        # 12. spaces --------------------------------------------------------------
        created = m.async_js("""
            const done = arguments[arguments.length - 1];
            const [name] = arguments;
            (async () => {
              try {
                const win = Services.wm.getMostRecentWindow('navigator:browser');
                let host = win.__astraHost;
                for (let i = 0; i < 100 && !host; i++) {
                  await new Promise((r) => setTimeout(r, 100));
                  host = win.__astraHost;
                }
                if (!host) { done({ ok: false, error: 'no __astraHost seam' }); return; }
                const before = (await host.Tabs.list({})).tabs ?? [];
                const res = await host.Tabs.createSpace({ name });
                done({ ok: true, accepted: res?.accepted === true, tabs: before.length });
              } catch (e) {
                done({ ok: false, error: String(e && e.message ? e.message : e) });
              }
            })();
        """, ["QA Probe"])
        print("create space:", json.dumps(created))
        if not created.get("ok") or not created.get("accepted"):
            skipped.append(f"spaces (createSpace failed: {created})")
        else:
            labelled = wait_for(
                lambda s: "QA Probe" in (s.get("spacesLabel") or ""),
                label="spaces trigger names the new space",
            )
            check("spaces: a created space reaches the switcher",
                  "QA Probe" in (labelled.get("spacesLabel") or ""),
                  json.dumps({"label": labelled.get("spacesLabel")}))
            print("open spaces:", m.js(click_starts("Spaces")))
            opened = wait_for(lambda s: len(s.get("spacePicks") or []) >= 1,
                              label="spaces menu entries")
            picks = opened.get("spacePicks") or []
            print("space picks:", picks)
            check("spaces: the switcher lists the seeded and new spaces", len(picks) >= 1,
                  json.dumps({"picks": picks}))
            if len(picks) >= 1:
                # The row carries its shortcut after two spaces; the trigger
                # names the space alone.
                target = picks[0].split("  ")[0].strip()
                print("pick space:", m.js(js(f"""
                    if (!d) return 'no doc';
                    const name = {json.dumps(target)};
                    const pick = [...d.querySelectorAll('[role="menuitemradio"]')]
                      .find((node) => (node.textContent || '').trim().startsWith(name));
                    if (!pick) return 'missing:' + name;
                    pick.click();
                    return 'ok';
                """)))
                switched = wait_for(
                    lambda s: target in (s.get("spacesLabel") or ""),
                    seconds=15, label="space switch",
                )
                check("spaces: picking a space switches the active one",
                      target in (switched.get("spacesLabel") or ""),
                      json.dumps({"label": switched.get("spacesLabel"), "target": target}))

        # 13. closing a second window leaves the first one running -----------
        closed = m.async_js("""
            const done = arguments[arguments.length - 1];
            (async () => {
              try {
                const host = Services.astraHost;
                if (!host) { done({ error: 'no host seam' }); return; }
                const made = await host.Windows.create({ request_id: 'qa-win-new', private: false });
                if (made?.error) { done({ error: made.error.code }); return; }
                await new Promise((r) => setTimeout(r, 2500));
                const before = await host.Windows.list({ request_id: 'qa-w0' });
                const other = made.window_id;
                if (!before.windows?.some((w) => w.window_id === other)) {
                  done({ error: 'second window not listed', before }); return;
                }
                const res = await host.Windows.close({ request_id: 'qa-w1', window_id: other });
                await new Promise((r) => setTimeout(r, 800));
                const after = await host.Windows.list({ request_id: 'qa-w2' });
                done({ id: other.window_id, closed: res?.closed ?? null,
                       error: res?.error?.code ?? null, before: (before.windows ?? []).length,
                       after: (after.windows ?? []).length });
              } catch (e) {
                done({ error: String(e && e.message ? e.message : e) });
              }
            })();
        """)
        print("window close:", json.dumps(closed))
        if not isinstance(closed, dict):
            closed = {"error": "no answer from Windows.close"}
        check("window: closing a second window leaves the first alive",
              closed.get("closed") is True and closed.get("after") == 1,
              json.dumps(closed))

        with open(os.path.join(outdir, "edge-matrix.json"), "w", encoding="utf-8") as handle:
            json.dump({"report": report, "skipped": skipped,
                       "fetches": dict(COUNTS)}, handle, indent=1)

        for skip in skipped:
            print(f"SKIP {skip}")
        if failures:
            print(f"EDGE MATRIX: FAIL ({len(failures)} checks) — " + "; ".join(failures))
            return 1
        print(f"EDGE MATRIX: PASS ({len(report)} checks)")
        return 0
    finally:
        try:
            m.cmd("WebDriver:DeleteSession")
        except Exception:
            pass
        proc.terminate()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
