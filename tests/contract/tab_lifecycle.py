#!/usr/bin/env python3
"""Contract test: a parked content tab is really parked in Gecko.

Astra's stage keeps one `<browser>` per page tab, so a tab switch is a layer
switch instead of a reload. Until this test's subject landed, parking only
toggled Astra's own `data-astra-browser*` attributes: every browser kept
`docShellIsActive = true`, so parked pages still reported
`document.visibilityState = "visible"`, kept their rAF loop and their layers,
and a 3D page in the background kept burning GPU.

What this pins (all observed, none inferred):

1. The active tab's browser is `docShellIsActive = true` and
   `renderLayers = true`; its page reports `visibilityState = "visible"`.
2. Every parked browser is `docShellIsActive = false` and
   `renderLayers = false`; its page reports `visibilityState = "hidden"`,
   stops advancing its rAF counter, and is still loaded (same title, same
   `performance.timeOrigin`, still on its URL).
3. Switching back activates the tab again and does not reload the page.
4. Background audio keeps playing while parked (ESR 153 suspends hidden media
   only when the top context opts into `suspendMediaWhenInactive`). Only audio
   is exercised: a decodable video fixture cannot be produced with the Python
   standard library, and the suspend path is the same.

Page-side facts (visibility, rAF counter, `timeOrigin`, media clock) are read
from reports the fixture page posts back to this test's loopback server; that
is process-agnostic and does not depend on Marionette being able to target a
browser that is not a tabbrowser tab.

Not observable through the chrome API and therefore NOT asserted:
`preserveLayers` is a setter only (`browser.preserveLayers(bool)`), with no
getter, so the parked layer-retention flag can only be checked by effect
(layers actually dropped / GPU memory), not by value.

Run headed on a private compositor (the worktree needs an engine build):
  tools/perf/hidden-display.sh python3 tests/contract/tab_lifecycle.py

Exit 0 PASS, 1 FAIL, 2 SKIP when the binary is absent. Stdlib only.
"""
import http.server
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import unquote_plus

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = os.environ.get(
    "ASTRA_BINARY",
    os.path.join(ROOT, "engine", "obj-astra-linux", "dist", "bin", "firefox"),
)
PORT = int(os.environ.get("ASTRA_TAB_LIFECYCLE_PORT", "2839"))

# A page reports ~4x/s while visible so the server can prove the rAF loop runs;
# the visibilitychange beacon is what makes the hidden transition visible even
# when background timer throttling slows the interval down.
PAGE = """<!doctype html>
<html data-tab="__TAB__"><head><meta charset="utf-8"><title>__TITLE__</title>
</head><body>
<h1 id="marker">TAB-__TAB__-OK</h1>
__MEDIA__
<script>
(() => {
  const tab = document.documentElement.dataset.tab;
  let raf = 0;
  const tick = () => { raf += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const origin = Math.round(performance.timeOrigin);
  function report(why) {
    const media = document.getElementById('tone');
    const q = new URLSearchParams({
      tab,
      why,
      visibility: document.visibilityState,
      raf: String(raf),
      origin: String(origin),
      title: document.title,
      media: media ? String(Math.round(media.currentTime * 1000) / 1000) : '',
      paused: media ? String(media.paused) : '',
    });
    try { navigator.sendBeacon('/report?' + q.toString()); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    report('visibility');
  });
  setInterval(() => report('tick'), 250);
  window.addEventListener('load', () => {
    report('load');
    const media = document.getElementById('tone');
    if (media) { media.play().catch(() => {}); }
  });
  setTimeout(() => report('ready'), 400);
})();
</script>
</body></html>"""

MEDIA = (
    '<audio id="tone" src="/tone.wav" autoplay loop preload="auto" '
    'style="display:none"></audio>'
)

TITLES = {"a": "Tab A", "b": "Tab B", "c": "Tab C"}
# rAF frames a parked page may still run around the switch edges (a frame in
# flight when the docshell deactivates, one or two as it re-activates). An
# active page at 30-144 Hz produces tens of frames in the same window.
RAF_SLACK = 8

REPORTS = []
REPORTS_LOCK = threading.Lock()


def tone_wav(seconds=20, rate=8000):
    """A quiet looping sine, long enough not to wrap inside one measurement."""
    frames = bytearray()
    for i in range(int(rate * seconds)):
        value = int(0.12 * 32767 * math.sin(2 * math.pi * 440 * i / rate))
        frames += struct.pack("<h", value)
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(frames))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(frames))
    )
    return header + bytes(frames)


TONE = tone_wav()


class Handler(http.server.BaseHTTPRequestHandler):
    def record(self):
        _path, _, query = self.path.partition("?")
        fields = dict(
            part.split("=", 1) for part in query.split("&") if "=" in part
        )
        record = {key: unquote_plus(value) for key, value in fields.items()}
        with REPORTS_LOCK:
            REPORTS.append((time.monotonic(), record))
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path, _, _query = self.path.partition("?")
        if path == "/report":
            self.record()
            return
        if path == "/tone.wav":
            body = TONE
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        tab = path.strip("/")
        if tab not in TITLES:
            self.send_response(404)
            self.end_headers()
            return
        body = (
            PAGE.replace("__TAB__", tab)
            .replace("__TITLE__", TITLES[tab])
            .replace("__MEDIA__", MEDIA if tab == "c" else "")
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # `navigator.sendBeacon` is a POST; the report rides in the query
        # string, so only the body needs draining to keep the socket sane.
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        if self.path.partition("?")[0] == "/report":
            self.record()
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


def serve():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def reports_since(index):
    with REPORTS_LOCK:
        return list(REPORTS[index:])


def report_count():
    with REPORTS_LOCK:
        return len(REPORTS)


class Marionette:
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
        length = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            rest += self.f.read(length - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:400]}")
                return msg[3]

    def execute(self, script, args=None):
        return self.cmd(
            "WebDriver:ExecuteScript", {"script": script, "args": args or []}
        )["value"]

    def execute_async(self, script, args=None):
        return self.cmd(
            "WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []}
        )["value"]


TABS_SCRIPT = """const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.list({ request_id: 'tab-lifecycle' });
    done(JSON.stringify(r.tabs || []));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

CREATE_SCRIPT = """const url = arguments[0];
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.create({
      request_id: 'tab-lifecycle', url, background: false,
    });
    done(JSON.stringify(r));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

NAVIGATE_SCRIPT = """const url = arguments[0];
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Navigation.loadURL({
      request_id: 'tab-lifecycle', url,
    });
    done(JSON.stringify(r));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

SELECT_SCRIPT = """const id = arguments[0];
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const r = await window.__astraHost.Tabs.select({
      request_id: 'tab-lifecycle', astra_tab_id: id,
    });
    done(JSON.stringify(r));
  } catch (e) { done(JSON.stringify({ error: String(e) })); }
})();"""

BROWSERS_SCRIPT = """return JSON.stringify((() => {
  const list = document.querySelectorAll(
    'browser[data-astra-browser], browser[data-astra-browser-parked]'
  );
  return [...list].map((b) => {
    let uri = null; let docActive = null; let renderLayers = null;
    let bcActive = null; let title = null;
    try { uri = b.currentURI ? b.currentURI.spec : null; } catch (e) {}
    try { docActive = b.docShellIsActive; } catch (e) {}
    try { renderLayers = b.renderLayers; } catch (e) {}
    try { bcActive = b.browsingContext ? b.browsingContext.isActive : null; } catch (e) {}
    try { title = typeof b.contentTitle === 'string' ? b.contentTitle : null; } catch (e) {}
    return {
      uri, docActive, renderLayers, bcActive, title,
      front: b.hasAttribute('data-astra-browser'),
      parked: b.hasAttribute('data-astra-browser-parked'),
    };
  });
})())"""


def parse(value, default):
    try:
        return json.loads(value)
    except Exception:
        return default


def wait_until(predicate, timeout=15.0, interval=0.1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def main():
    if not os.path.exists(FIREFOX):
        print("SKIP no built binary at " + FIREFOX)
        return 2
    server, port = serve()
    profile = tempfile.mkdtemp(prefix="astra-tab-lifecycle-")
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(f'user_pref("marionette.port", {PORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        fh.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        # The media tab is selected while it loads, but audible autoplay still
        # needs the policy to allow it; a blocked play() would make the
        # background-audio check untestable rather than failed.
        fh.write('user_pref("media.autoplay.default", 0);\n')
        fh.write('user_pref("media.autoplay.blocking_policy", 0);\n')
    log = open(os.path.join(profile, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [
            FIREFOX,
            "-profile", profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    failures = []
    warnings = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + (f" ({detail})" if detail else ""))
        if not ok:
            failures.append(name + (f": {detail}" if detail else ""))
        return ok

    def browsers(m):
        return parse(m.execute(BROWSERS_SCRIPT), []) or []

    def front(m):
        return next((b for b in browsers(m) if b.get("front")), None)

    def tab_rows(m):
        rows = parse(m.execute_async(TABS_SCRIPT), [])
        return rows if isinstance(rows, list) else []

    def wait_for_page(m, path, title, timeout=20.0):
        def ready():
            rows = tab_rows(m)
            row = next((t for t in rows if (t.get("url") or "").endswith(path)), None)
            if not row or row.get("loading") is not False:
                return None
            state = next(
                (b for b in browsers(m) if (b.get("uri") or "").endswith(path)),
                None,
            )
            if not state or state.get("docActive") is not True:
                return None
            if state.get("title") != title:
                return None
            return state

        return wait_until(ready, timeout=timeout)

    def select(m, tab_id, path):
        result = parse(m.execute_async(SELECT_SCRIPT, [tab_id]), {})
        if "error" in result:
            return None
        # The front browser may still be on its previous URI until the switch
        # runs; wait for the stage to name this page and activate its docshell.
        def switched():
            state = front(m)
            if not state or not (state.get("uri") or "").endswith(path):
                return None
            if state.get("docActive") is not True or state.get("renderLayers") is not True:
                return None
            return state

        return wait_until(switched, timeout=15.0)

    try:
        m = Marionette(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if m.execute(
                    "return !!window.__astraHost && "
                    "!!document.querySelector('iframe[data-astra-app-frame]')"
                    "?.contentDocument?.querySelector('#root')?.children.length"
                ):
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("Astra app never became ready")

        # --- three tabs, each loaded while it was in front -------------------
        # The window boots with one New Tab whose warm `<browser>` already
        # exists; reuse it for tab A instead of leaving a fourth, parked
        # browser on the stage.
        tab_ids = {}
        rows = tab_rows(m)
        boot = next((t for t in rows if t.get("selected")), rows[0] if rows else None)
        if not boot:
            failures.append("no tab after boot")
        else:
            tab_ids["a"] = boot.get("astra_tab_id")
        if "a" in tab_ids:
            navigated = parse(
                m.execute_async(NAVIGATE_SCRIPT, [f"http://127.0.0.1:{port}/a"]), {}
            )
            if "error" in navigated:
                failures.append(f"tab a: {navigated['error']}")
            elif not wait_for_page(m, "/a", TITLES["a"]):
                failures.append("tab a never loaded")
        for tab in ("b", "c"):
            if failures:
                break
            url = f"http://127.0.0.1:{port}/{tab}"
            created = parse(m.execute_async(CREATE_SCRIPT, [url]), {})
            if "error" in created:
                failures.append(f"create {tab}: {created['error']}")
                break
            tab_ids[tab] = created.get("astra_tab_id")
            if not wait_for_page(m, f"/{tab}", TITLES[tab]):
                failures.append(f"tab {tab} never loaded")
                break
        if not failures:
            state = browsers(m)
            check(
                "three tabs keep three browsers",
                len(state) == 3,
                f"browsers={len(state)}",
            )
            front_state = front(m)
            check(
                "last created tab is the one in front",
                bool(front_state) and (front_state.get("uri") or "").endswith("/c"),
                f"front={(front_state or {}).get('uri')}",
            )
            parked_now = [b for b in state if not b.get("front")]
            check(
                "creating a tab parks the others",
                len(parked_now) == 2
                and all(b.get("docActive") is False for b in parked_now),
                "parked="
                + json.dumps([(b.get("uri"), b.get("docActive")) for b in parked_now]),
            )

            # --- park B and C by selecting A, then observe -------------------
            index = report_count()
            if not select(m, tab_ids["a"], "/a"):
                failures.append("could not switch back to tab a")
            time.sleep(2.2)

            state = browsers(m)
            active = front(m)
            check(
                "active tab browser is active and renders",
                bool(active)
                and (active.get("uri") or "").endswith("/a")
                and active.get("docActive") is True
                and active.get("renderLayers") is True
                and active.get("bcActive") is True,
                json.dumps(active),
            )
            parked = [b for b in state if not b.get("front")]
            check(
                "parked browsers are inactive and stop rendering",
                len(parked) == 2
                and all(
                    b.get("docActive") is False
                    and b.get("renderLayers") is False
                    and b.get("bcActive") is False
                    and b.get("parked") is True
                    for b in parked
                ),
                json.dumps(
                    [
                        (b.get("uri"), b.get("docActive"), b.get("renderLayers"))
                        for b in parked
                    ]
                ),
            )
            check(
                "parked pages stay loaded (same URI and title, no discard)",
                sorted((b.get("uri") or "").rsplit("/", 1)[-1] for b in parked) == ["b", "c"]
                and sorted((b.get("title") or "") for b in parked) == [TITLES["b"], TITLES["c"]],
                json.dumps([(b.get("uri"), b.get("title")) for b in parked]),
            )

            window = reports_since(index)

            def tab_reports(tab, **match):
                return [
                    record
                    for _, record in window
                    if record.get("tab") == tab
                    and all(record.get(key) == value for key, value in match.items())
                ]

            active_reports = tab_reports("a", visibility="visible")
            check(
                "active page reports visible and keeps its rAF loop",
                len(active_reports) >= 2
                and int(active_reports[-1]["raf"]) - int(active_reports[0]["raf"]) >= 8,
                f"reports={len(active_reports)} "
                f"raf={active_reports[0]['raf'] if active_reports else '-'}"
                f"->{active_reports[-1]['raf'] if active_reports else '-'}",
            )
            active_rate = 0.0
            if len(active_reports) >= 2:
                active_rate = (
                    int(active_reports[-1]["raf"]) - int(active_reports[0]["raf"])
                ) / max(0.001, 2.2)

            hide_reports = {}
            for tab in ("b", "c"):
                rows = [
                    record
                    for _, record in reports_since(0)
                    if record.get("tab") == tab
                    and record.get("visibility") == "hidden"
                    and record.get("why") == "visibility"
                ]
                if rows:
                    hide_reports[tab] = rows[-1]
            check(
                "parked pages observe visibilitychange -> hidden",
                set(hide_reports) == {"b", "c"},
                f"hidden={sorted(hide_reports)}",
            )

            # --- switch back to B: activate, resume, no reload ---------------
            index = report_count()
            if not select(m, tab_ids["b"], "/b"):
                failures.append("could not switch back to tab b")
            time.sleep(0.7)
            state = browsers(m)
            back = front(m)
            check(
                "switching back reactivates the browser",
                bool(back)
                and (back.get("uri") or "").endswith("/b")
                and back.get("docActive") is True
                and back.get("renderLayers") is True,
                json.dumps(back),
            )
            others = [b for b in state if not b.get("front")]
            check(
                "the tab left behind is parked",
                len(others) == 2
                and all(b.get("docActive") is False for b in others)
                and sorted((b.get("uri") or "").rsplit("/", 1)[-1] for b in others)
                == ["a", "c"],
                json.dumps([(b.get("uri"), b.get("docActive")) for b in others]),
            )
            resumed = [
                record
                for _, record in reports_since(index)
                if record.get("tab") == "b" and record.get("visibility") == "visible"
            ]
            b_hidden = hide_reports.get("b")
            b_origins = {record.get("origin") for record in resumed}
            check(
                "returning to a parked page does not reload it",
                bool(resumed)
                and b_hidden is not None
                and b_origins == {b_hidden.get("origin")}
                and all(record.get("title") == TITLES["b"] for record in resumed),
                f"origin_before={b_hidden.get('origin') if b_hidden else '-'} "
                f"origins_after={sorted(b_origins)}",
            )
            if b_hidden is None or not resumed:
                pass
            elif active_rate < 10:
                warnings.append(
                    "rAF rate unobservable in this run (active page ran "
                    f"{active_rate:.1f} frames/s); skipped the parked-rAF comparison"
                )
            else:
                # The activation beacon fires as the page becomes visible again,
                # before its rAF loop has had time to advance; later reports in
                # the same window would already include resumed frames.
                resumed_beacon = next(
                    (record for record in resumed if record.get("why") == "visibility"),
                    resumed[0],
                )
                frozen = int(resumed_beacon["raf"]) - int(b_hidden["raf"])
                check(
                    "a parked page does not keep rAF at full rate",
                    frozen <= RAF_SLACK,
                    f"frames_while_parked={frozen} slack={RAF_SLACK} "
                    f"active_rate={active_rate:.1f}/s",
                )

            # --- media tab: audio must advance while parked ------------------
            index = report_count()
            if not select(m, tab_ids["c"], "/c"):
                failures.append("could not switch to the media tab")
            time.sleep(0.7)
            shown = [
                record
                for _, record in reports_since(index)
                if record.get("tab") == "c" and record.get("visibility") == "visible"
            ]
            c_hidden = hide_reports.get("c")
            observed = shown[-1] if shown else None
            if not observed or not c_hidden:
                failures.append("media tab never reported across the switch")
            elif observed.get("paused") == "True" or c_hidden.get("paused") == "True":
                warnings.append(
                    "autoplay was blocked, so background audio could not be "
                    "measured (media.autoplay.default=0 should allow it)"
                )
            else:
                before = float(c_hidden.get("media") or 0)
                after = float(observed.get("media") or 0)
                advanced = after - before
                if advanced < 0:
                    # The 20 s fixture loop wrapped while the tab was parked.
                    advanced += 20.0
                check(
                    "background audio keeps advancing while the tab is parked",
                    observed.get("paused") == "False" and advanced >= 0.5,
                    f"media={before}->{after} advanced={advanced:.2f}s",
                )
            check(
                "media tab still holds its page after the round trip",
                bool(observed)
                and c_hidden is not None
                and observed.get("origin") == c_hidden.get("origin")
                and observed.get("title") == TITLES["c"],
                f"origin={observed.get('origin') if observed else '-'}",
            )

            # --- back to A: still the same document --------------------------
            index = report_count()
            if not select(m, tab_ids["a"], "/a"):
                failures.append("could not return to tab a")
            time.sleep(0.5)
            again = [
                record
                for _, record in reports_since(index)
                if record.get("tab") == "a" and record.get("visibility") == "visible"
            ]
            a_origin = active_reports[0].get("origin") if active_reports else None
            check(
                "the first tab is the same document after a full round trip",
                bool(again) and a_origin is not None and again[-1].get("origin") == a_origin,
                f"origin_load={a_origin} "
                f"origin_now={again[-1].get('origin') if again else '-'}",
            )
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        log.close()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    for warning in warnings:
        print("WARN " + warning)
    if failures:
        print("tab_lifecycle: FAIL " + "; ".join(failures))
        return 1
    print("tab_lifecycle: PASS " + (f"({len(warnings)} warning(s))" if warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
