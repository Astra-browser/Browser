#!/usr/bin/env python3
"""P3-T11 in-Firefox golden capture: render the P0-T07 golden matrix with the
real Astra build (Gecko) and screenshot each screen into
tests/golden/in-firefox/ for diffing against tests/golden/baseline/.

Method (reuses the P1-T11 contract-harness pattern — geckodriver + Marionette,
stdlib only):
  1. Serve tools/golden-capture/dist/ (the mocked golden UI build) over
     loopback, with the wall clock frozen (see below).
  2. Boot the real Astra binary headless via the in-tree geckodriver with a
     fresh profile (TZ=UTC, en-US, reduced motion, devPixelsPerPx=1.0,
     ui.systemUsesDarkTheme per entry — mirrors Playwright colorScheme).
  3. For each manifest entry: size the window so Astra's *content slot* is
     exactly the entry viewport, load golden.html?screen=&theme= into that
     slot, wait for network STOP + settle, screenshot the slot via
     drawSnapshot.

Design notes (all measured 2026-11-02, this host+build):
  - WebDriver /screenshot 500s ("Unable to capture screenshot", empty
    message) and --screenshot CLI fails on the SWGL compositor; the
    drawSnapshot stage of that same pipeline works when driven directly
    from chrome scope. Same binary, same window, same Gecko pixels.
  - The tabbrowser's browser is display:none (shell-chrome.css) so its
    viewport is 0x0; captures go through Astra's real content slot
    ([data-astra-browser]), which is the surface real web content renders on.
    Astra urlbar/about chrome is cropped out (outside the slot rect) — the
    baseline asserts the UI, never host chrome.
  - Host-API navigation (Content.navigate) updates the Tabs model but the
    mounted slot browser stays about:blank (no nav.committed follow observed
    in headless even after 11s — flagged in DEVIATIONS.md for the owning
    lane). The harness loads the slot browser directly with the system
    principal; the render path below that (docshell, layout, paint) is the
    product's own.
  - Ready detection: content DOM is cross-process (no DOM access from chrome
    scope), so readiness is progress-listener STATE_STOP on the slot browser
    + 1.2s settle (fonts are local system files; first screen warms them).
  - Clock pin: capture.ts froze Date via Playwright addInitScript. Marionette
    has no pre-script hook, so the server injects a tiny classic <script> as
    the first child of <head> in the served golden.html (response-time
    rewrite — no repo file touched). Classic head scripts run before any
    module graph, so the freeze lands before golden boot reads Date.now().
    Same PINNED_ISO as manifest.ts (parsed — source of truth stays there).

Env overrides (worktree has no engine/ checkout; never modify the real one):
  ASTRA_BINARY      default <main>/engine/obj-astra-linux/dist/bin/firefox
  ASTRA_GECKODRIVER default <main>/engine/obj-astra-linux/dist/host/bin/geckodriver
  ASTRA_MAIN        default /home/rem/Projects/Astra
  ASTRA_WD_PORT     default 44452

Exit codes: 0 all captured, 1 failure, 2 binary/geckodriver absent (SKIP).
"""
import base64
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAIN = os.environ.get("ASTRA_MAIN", "/home/rem/Projects/Astra")
FIREFOX = os.environ.get(
    "ASTRA_BINARY",
    os.path.join(MAIN, "engine", "obj-astra-linux", "dist", "bin", "firefox"),
)
GECKODRIVER = os.environ.get(
    "ASTRA_GECKODRIVER",
    os.path.join(MAIN, "engine", "obj-astra-linux", "dist", "host", "bin", "geckodriver"),
)
DIST = os.path.join(HERE, "dist")
OUTDIR = os.path.join(ROOT, "tests", "golden", "in-firefox")
MANIFEST_TS = os.path.join(HERE, "manifest.ts")
PORT = int(os.environ.get("ASTRA_WD_PORT", "44452"))
SETTLE_S = 1.2

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".avif": "image/avif",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

FREEZE_TMPL = """<script>(()=>{const FROZEN=Date.parse(PINNED);const R=Date;
class FD extends R{constructor(...a){super(...(a.length?a:[FROZEN]));}static now(){return FROZEN;}}
globalThis.Date=FD;})();</script>"""


def pinned_iso():
    with open(MANIFEST_TS) as f:
        src = f.read()
    m = re.search(r'PINNED_ISO\s*=\s*"([^"]+)"', src)
    if not m:
        raise RuntimeError("PINNED_ISO not found in manifest.ts")
    return m.group(1)


def manifest_matrix():
    with open(MANIFEST_TS) as f:
        src = f.read()
    screens = re.findall(r'"(shell|spaces|newtab|launcher|tasks|notes|time|settings)"', src)
    seen, ordered = set(), []
    for s in screens:
        if s not in seen:
            seen.add(s)
            ordered.append(s)
    entries = []
    for screen in ordered:
        for theme in ("light", "dark"):
            entries.append({"name": f"{screen}-{theme}", "screen": screen,
                            "theme": theme, "width": 1440, "height": 900})
    for theme in ("light", "dark"):
        entries.append({"name": f"shell-{theme}-narrow", "screen": "shell",
                        "theme": theme, "width": 390, "height": 844})
    return entries


class GoldenServer:
    """Loopback static server for DIST with the Date-freeze injected into
    golden.html at serve time (see module docstring)."""

    def __init__(self, freeze):
        self.freeze = freeze
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                path = self.path.split("?", 1)[0].split("#", 1)[0]
                if path == "/":
                    path = "/golden.html"
                rel = os.path.normpath(path.lstrip("/"))
                if rel.startswith(".."):
                    self.send_error(404)
                    return
                full = os.path.join(DIST, rel)
                if not os.path.isfile(full):
                    self.send_error(404, "not found")
                    return
                ext = os.path.splitext(full)[1]
                data = open(full, "rb").read()
                if os.path.basename(full) == "golden.html":
                    text = data.decode()
                    assert "<head>" in text, "golden.html has no <head>"
                    data = text.replace("<head>", "<head>" + outer.freeze, 1).encode()
                self.send_response(200)
                self.send_header("content-type",
                                 MIME.get(ext, "application/octet-stream"))
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.thread.join(timeout=10)

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"


# --- chrome-scope scripts (run with moz/context = chrome) ---

SETUP_SCRIPT = """return (()=>{
const w = Services.wm.getMostRecentWindow('navigator:browser');
// About-details and hbox#browser are Astra/Firefox chrome around the slot;
// the baseline asserts the UI, never host chrome — hide them so the slot
// takes the freed height.
const d = w.document.querySelector('details.astra-about');
if (d) d.style.display = 'none';
// hbox#browser (the hidden Firefox content area) still occupies flex height
// (measured 347px at 960 winH); without hiding it the slot can never reach
// full-viewport sizes. Test-only live style; no repo file touched.
const hb = w.document.getElementById('browser');
if (hb) hb.style.display = 'none';
// Network STOP on the slot browser = document + subresources committed.
const b = w.document.querySelector('[data-astra-browser]');
const listener = {QueryInterface: ChromeUtils.generateQI(
  ['nsIWebProgressListener', 'nsISupportsWeakReference']),
 onStateChange(prog, req, flags, status) { try {
  const STOP = Ci.nsIWebProgressListener.STATE_STOP;
  const NET = Ci.nsIWebProgressListener.STATE_IS_NETWORK;
  if ((flags & STOP) && (flags & NET)) { w.__goldDone = Date.now(); }
 } catch (e) {}},
 onLocationChange(){}, onProgressChange(){}, onStatusChange(){},
 onSecurityChange(){}, onContentBlockingEvent(){}};
b.addProgressListener(listener);
w.__goldListener = listener; // strong ref: weak listener would be GC'd
w.__goldDone = 0;
return true;})();"""

LOAD_SCRIPT = """const url = arguments[0];
const dark = arguments[1] ? 1 : 0;
return (() => {
const w = Services.wm.getMostRecentWindow('navigator:browser');
const b = w.document.querySelector('[data-astra-browser]');
w.__goldDone = 0;
// Mirror Playwright's per-capture `colorScheme` (capture.ts): the golden UI
// reads prefers-color-scheme (theme init fallback, bootstrap paint, native
// control tones), so the engine must report the entry's scheme.
Services.prefs.setIntPref('ui.systemUsesDarkTheme', dark);
b.fixupAndLoadURIString(url,
  { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
const r = b.getBoundingClientRect();
return [Math.round(r.width), Math.round(r.height)];})();"""

POLL_SCRIPT = """return (() => {
const w = Services.wm.getMostRecentWindow('navigator:browser');
const b = w.document.querySelector('[data-astra-browser]');
const r = b.getBoundingClientRect();
return [w.__goldDone || 0, Math.round(r.width), Math.round(r.height)];})();"""

SNAP_SCRIPT = """const sw = arguments[0], sh = arguments[1];
const done = arguments[arguments.length - 1];
(async () => { try {
 const w = Services.wm.getMostRecentWindow('navigator:browser');
 const b = w.document.querySelector('[data-astra-browser]');
 const bg = b.browsingContext.currentWindowGlobal;
 const snap = await bg.drawSnapshot(new w.DOMRect(0, 0, sw, sh), 1,
   'rgb(255,255,255)');
 const c = w.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
 c.width = sw; c.height = sh;
 c.getContext('2d').drawImage(snap, 0, 0);
 snap.close();
 done(['OK', c.toDataURL('image/png')]);
} catch (e) { done(['ERR', String((e && e.message) || e).slice(0, 200)]); } })();"""


def make_wd(base):
    def wd(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)["value"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}")

    return wd


def chromex(wd, session, script, args=None, async_=False):
    wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
    try:
        ep = "async" if async_ else "sync"
        return wd("POST", f"/session/{session}/execute/" + ep,
                  {"script": script, "args": args or []})
    finally:
        wd("POST", f"/session/{session}/moz/context", {"context": "content"})


def ensure_dist():
    if os.path.isfile(os.path.join(DIST, "golden.html")):
        return
    print("[in-firefox] dist missing, building golden UI…", flush=True)
    proc = subprocess.run(
        ["bunx", "vite", "build", "--config", "vite.golden.config.ts"],
        cwd=os.path.join(ROOT, "ui", "app"),
    )
    if proc.returncode != 0:
        raise RuntimeError("golden UI build failed")


def fit_slot(wd, session, width, height):
    """Size the window so the content slot is exactly width x height."""
    wd("POST", f"/session/{session}/window/rect",
       {"width": width, "height": height + 60})
    for _ in range(6):
        _, cw, ch = chromex(wd, session, POLL_SCRIPT)
        if cw == width and ch == height:
            return cw, ch
        rect = wd("GET", f"/session/{session}/window/rect")
        dh = height - ch
        dw = width - cw
        wd("POST", f"/session/{session}/window/rect",
           {"width": rect["width"] + dw, "height": rect["height"] + dh})
        time.sleep(0.4)
    _, cw, ch = chromex(wd, session, POLL_SCRIPT)
    raise RuntimeError(f"slot would not converge to {width}x{height} (got {cw}x{ch})")


def main():
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            print(f"SKIP: missing {f} (run a full build first)")
            return 2
    ensure_dist()
    freeze = FREEZE_TMPL.replace("PINNED", json.dumps(pinned_iso()))
    entries = manifest_matrix()
    os.makedirs(OUTDIR, exist_ok=True)

    # MOZ_ACCELERATED=0: this host's GPU probing breaks the headless SWGL
    # compositor ("failed mapping default framebuffer" -> even --screenshot
    # CLI fails). Software compositing renders fine; layout/text unaffected.
    env = dict(os.environ, TZ="UTC", LANG="en_US.UTF-8", MOZ_ACCELERATED="0")
    gd_log = open(os.path.join(OUTDIR, "geckodriver.log"), "w")
    gd = subprocess.Popen([GECKODRIVER, "--port", str(PORT)],
                          stdout=gd_log, stderr=subprocess.STDOUT, env=env)
    try:
        wd = make_wd(f"http://127.0.0.1:{PORT}")
        for _ in range(100):
            try:
                wd("GET", "/status")
                break
            except OSError:
                time.sleep(0.2)
        profile = tempfile.mkdtemp(prefix="astra-golden-")
        session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {
            "moz:firefoxOptions": {
                "binary": FIREFOX,
                "args": ["--headless", "--no-remote",
                         "-remote-allow-system-access",
                         "--profile", profile],
                "prefs": {
                    "intl.locale.requested": "en-US",
                    "ui.prefersReducedMotion": 1,
                    "layout.css.devPixelsPerPx": "1.0",
                    "browser.shell.checkDefaultBrowser": False,
                    "browser.aboutwelcome.enabled": False,
                    "datareporting.policy.dataSubmissionEnabled": False,
                },
            }}}})["sessionId"]
        try:
            for _ in range(100):
                try:
                    wd("GET", f"/session/{session}/title")
                    break
                except RuntimeError:
                    time.sleep(0.3)
            results = []
            skipped = []
            with GoldenServer(freeze) as srv:
                chromex(wd, session, SETUP_SCRIPT)
                for entry in entries:
                    try:
                        cw, ch = fit_slot(wd, session, entry["width"], entry["height"])
                    except RuntimeError as e:
                        # Headless window floor is 500px wide (measured): the
                        # 390px narrow entries cannot be sized. Record and
                        # continue — compare.py reports them as SKIP.
                        rect = wd("GET", f"/session/{session}/window/rect")
                        if entry["width"] < rect["width"]:
                            reason = (f"window floor {rect['width']}px > "
                                      f"entry {entry['width']}px ({e})")
                            print(f"[in-firefox] {entry['name']} SKIP: {reason}",
                                  flush=True)
                            skipped.append({"name": entry["name"], "reason": reason})
                            continue
                        raise
                    url = (f"{srv.base}/golden.html?screen={entry['screen']}"
                           f"&theme={entry['theme']}")
                    chromex(wd, session, LOAD_SCRIPT,
                            [url, entry["theme"] == "dark"])
                    done = 0
                    for _ in range(60):
                        done, cw, ch = chromex(wd, session, POLL_SCRIPT)
                        if done:
                            break
                        time.sleep(0.5)
                    if not done:
                        raise RuntimeError(f"{entry['name']}: network STOP never fired")
                    if (cw, ch) != (entry["width"], entry["height"]):
                        raise RuntimeError(
                            f"{entry['name']}: slot drifted to {cw}x{ch}")
                    time.sleep(SETTLE_S)
                    status, payload = chromex(
                        wd, session, SNAP_SCRIPT, [cw, ch], async_=True)
                    if status != "OK":
                        raise RuntimeError(f"{entry['name']}: snapshot failed: {payload}")
                    assert payload.startswith("data:image/png;base64,"), payload[:60]
                    out = os.path.join(OUTDIR, entry["name"] + ".png")
                    with open(out, "wb") as f:
                        f.write(base64.b64decode(payload.split(",", 1)[1]))
                    size = os.path.getsize(out)
                    print(f"[in-firefox] {entry['name']} "
                          f"slot={cw}x{ch} {size // 1024} KiB", flush=True)
                    results.append({"name": entry["name"], "bytes": size,
                                    "slot": [cw, ch]})
            with open(os.path.join(OUTDIR, "captures.json"), "w") as f:
                json.dump({"firefox": FIREFOX, "geckodriver": GECKODRIVER,
                           "pinnedClock": pinned_iso(), "timezone": "UTC",
                           "locale": "en-US", "settle_s": SETTLE_S,
                           "captures": results, "skipped": skipped}, f, indent=1)
            print(f"[in-firefox] {len(results)}/{len(entries)} → {OUTDIR} "
                  f"({len(skipped)} skipped)")
            return 0
        finally:
            try:
                wd("DELETE", f"/session/{session}")
            except Exception:
                pass
            shutil.rmtree(profile, ignore_errors=True)
    finally:
        gd.terminate()
        try:
            gd.wait(timeout=15)
        except subprocess.TimeoutExpired:
            gd.kill()
        gd_log.close()


if __name__ == "__main__":
    sys.exit(main())
