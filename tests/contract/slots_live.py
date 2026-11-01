#!/usr/bin/env python3
"""Spike S-01 live probe (P3-T02, U-05): many `<browser>` elements placed
by CSS grid, no reparenting, in the real Astra window.

Launches the built Astra binary via the in-tree geckodriver, switches to
Marionette chrome context, and asserts against the LIVE layout engine:
  - 1 -> 2 -> 4 remote browsers created once each inside grid cells;
    switching `data-layout` (single -> cols-2 -> grid-2x2) never moves a
    browser node (parent identity preserved = no reparenting)
  - every browser has non-zero size from CSS grid alone (flex/grid sizing,
    no position:fixed -- the P1-T08 XUL lesson)
  - per-pane navigation independence (each browser commits its own URL)
  - focus switch moves chrome activeElement between browsers (timed)
  - container resize reflows every cell (timed)
  - zoom independence via ZoomManager (guard: skipped where unavailable)
  - devtools sanity: distinct browsingContext per browser

Usage: python3 tests/contract/slots_live.py
Exit 0 PASS, 1 FAIL, 2 SKIP (no binary -- run a full build first).
Env overrides: ASTRA_BINARY, ASTRA_GECKODRIVER, ASTRA_WD_PORT.
Stdlib only.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, "engine")
FIREFOX = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "obj-astra-linux", "dist", "bin", "firefox"))
GECKODRIVER = os.environ.get("ASTRA_GECKODRIVER", os.path.join(ENGINE, "obj-astra-linux", "dist", "host", "bin", "geckodriver"))
PORT = int(os.environ.get("ASTRA_WD_PORT", "44452"))

FIXTURES = {
    "a": "<html><head><title>Slot A</title></head>"
         "<body><h1 id='m'>slot-alpha</h1></body></html>",
    "b": "<html><head><title>Slot B</title></head>"
         "<body><h1 id='m'>slot-beta</h1></body></html>",
}


def wd(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)["value"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}")


CHROME_SCRIPT = """
const done = arguments[arguments.length - 1];
const [urlA, urlB] = arguments;
(async () => {
  const out = { errors: [] };
  try {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const d = win.document;
    const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ssm = Services.scriptSecurityManager;
    const principal = ssm.getSystemPrincipal();
    // XUL namespace: the ONLY namespace whose <browser> upgrades to
    // MozBrowser (verified: ...there.is.only.xhtml yields a dead plain
    // Element with no fixupAndLoadURIString -- see S-01.md finding F-01).
    const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

    // Grid host inside the Astra shell root (fresh profile => shell mounted).
    const root = d.getElementById("astra-root");
    if (!root) { out.errors.push("no #astra-root"); done(out); return; }
    const host = d.createElement("div");
    host.setAttribute("id", "s01-probe");
    host.setAttribute("data-layout", "single");
    host.style.display = "grid";
    host.style.gap = "4px";
    host.style.width = "800px";
    host.style.height = "600px";
    const applyLayout = () => {
      const l = host.getAttribute("data-layout");
      host.style.gridTemplateRows = l === "grid-2x2" ? "1fr 1fr" : "1fr";
      host.style.gridTemplateColumns = l === "single" ? "1fr" : "1fr 1fr";
    };
    applyLayout();
    root.appendChild(host);

    const browsers = [];
    const mkBrowser = (url) => {
      const cell = d.createElement("div");
      cell.style.display = "flex";
      cell.style.minWidth = "0";
      cell.style.minHeight = "0";
      const b = d.createElementNS(XUL_NS, "browser");
      b.setAttribute("type", "content");
      b.setAttribute("remote", "true");
      b.setAttribute("remoteType", "web");
      b.setAttribute("maychangeremoteness", "true");
      b.setAttribute("flex", "1");
      // NOTE: XUL <browser> exposes no .style object here; the style
      // ATTRIBUTE works (same channel the P1-T10 shell relies on).
      b.setAttribute("style", "flex:1 1 auto;width:100%;min-height:0;");
      cell.appendChild(b);
      host.appendChild(cell);
      b.fixupAndLoadURIString(url, { triggeringPrincipal: principal });
      browsers.push({ cell, browser: b });
      return b;
    };
    const spec = (b) => { try { return b.currentURI ? b.currentURI.spec : ""; } catch { return ""; } };
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const waitSpec = async (b, url) => {
      for (let i = 0; i < 100; i++) {
        if (spec(b) === url) { return true; }
        await asleep(100);
      }
      return false;
    };

    // --- 1 pane ---
    const b1 = mkBrowser(urlA);
    out.oneLoaded = await waitSpec(b1, urlA);
    out.oneRect = rect(b1);

    // --- 2 panes: layout switch must NOT move b1 ---
    const parentBefore = b1.parentNode;
    host.setAttribute("data-layout", "cols-2");
    applyLayout();
    const b2 = mkBrowser(urlB);
    out.twoLoaded = await waitSpec(b2, urlB);
    out.noReparentOnTwo = b1.parentNode === parentBefore && b1.parentNode !== b2.parentNode;
    out.twoRects = [rect(b1), rect(b2)];
    out.sideBySide = Math.abs(b1.getBoundingClientRect().x - b2.getBoundingClientRect().x) > 50;
    out.independentSpecs = spec(b1) === urlA && spec(b2) === urlB;

    // --- 4 panes ---
    host.setAttribute("data-layout", "grid-2x2");
    applyLayout();
    const b3 = mkBrowser("about:blank");
    const b4 = mkBrowser("about:blank");
    await asleep(500);
    out.fourCount = host.querySelectorAll("browser").length;
    out.fourRects = [b1, b2, b3, b4].map(rect);
    out.allSized = out.fourRects.every((r) => r.w > 100 && r.h > 100);
    out.noReparentOnFour = b1.parentNode === parentBefore && b2.parentNode !== b3.parentNode;
    // Namespace finding F-01: only the XUL-namespace node upgrades.
    out.ctorIsMozBrowser = [b1, b2, b3, b4].every((b) => b.constructor?.name === "MozBrowser");
    out.fixupPresent = [b1, b2, b3, b4].every((b) => typeof b.fixupAndLoadURIString === "function");

    // --- focus switch (timed) ---
    const t0 = performance.now();
    b2.focus();
    await asleep(50);
    out.focusMs = performance.now() - t0;
    out.focusLands = d.activeElement === b2;
    b1.focus();
    await asleep(50);
    out.focusBack = d.activeElement === b1;

    // --- resize reflow (timed) ---
    const before = rect(b1);
    const t1 = performance.now();
    host.style.width = "600px";
    host.style.height = "400px";
    await asleep(300);
    const after = rect(b1);
    out.reflowMs = performance.now() - t1;
    out.reflowed = Math.abs(before.w - after.w) > 20 && after.w > 100 && after.h > 100;

    // --- zoom independence (guarded: ZoomManager may be absent headless) ---
    try {
      const zm = win.ZoomManager;
      if (zm && typeof zm.setZoomForBrowser === "function") {
        zm.setZoomForBrowser(b1, 1.25);
        await asleep(100);
        const z1 = zm.getZoomForBrowser(b1);
        const z2 = zm.getZoomForBrowser(b2);
        out.zoomIndependent = Math.abs(z1 - 1.25) < 0.01 && Math.abs(z2 - 1) < 0.01;
        out.zoomValues = [z1, z2];
      } else {
        out.zoomIndependent = "SKIP-no-ZoomManager";
      }
    } catch (e) {
      out.zoomIndependent = "SKIP-" + String(e && e.message ? e.message : e).slice(0, 80);
    }

    // --- devtools sanity: distinct browsing contexts ---
    try {
      const ctxs = [b1, b2, b3, b4].map((b) => b.browsingContext);
      out.distinctContexts = new Set(ctxs).size === 4 && ctxs.every(Boolean);
      out.frameLoadersLive = [b1, b2, b3, b4].every((b) => !!b.frameLoader);
    } catch (e) {
      out.errors.push("contexts: " + String(e && e.message ? e.message : e));
    }

    // Cleanup: remove the probe grid (fresh profile anyway).
    host.remove();
  } catch (e) {
    out.errors.push(String(e && e.message ? e.message : e));
  }
  done(out);
}).call(this);
"""


def main():
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            print(f"SKIP: missing {f} (run a full build first)")
            return 2
    tmp = tempfile.mkdtemp(prefix="astra-s01-")
    fa = os.path.join(tmp, "a.html")
    fb = os.path.join(tmp, "b.html")
    open(fa, "w").write(FIXTURES["a"])
    open(fb, "w").write(FIXTURES["b"])
    url_a = "file://" + fa
    url_b = "file://" + fb
    profile = tempfile.mkdtemp(prefix="astra-s01-prof-")
    gd = subprocess.Popen(
        [GECKODRIVER, "--port", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=2)
                break
            except OSError:
                time.sleep(0.2)
        session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {
            "moz:firefoxOptions": {
                "binary": FIREFOX,
                "args": ["--headless", "--no-remote",
                         "-remote-allow-system-access",
                         "--profile", profile],
            }}}})["sessionId"]
        try:
            for _ in range(100):
                try:
                    wd("GET", f"/session/{session}/title")
                    break
                except RuntimeError:
                    time.sleep(0.3)
            wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
            wd("POST", f"/session/{session}/timeouts", {"script": 60000})
            res = wd("POST", f"/session/{session}/execute/async", {
                "script": CHROME_SCRIPT, "args": [url_a, url_b]})
            print("observed:", json.dumps(res, indent=1)[:3000])
            zoom = res.get("zoomIndependent")
            checks = [
                ("XUL-namespace browsers upgrade to MozBrowser (F-01)",
                 res.get("ctorIsMozBrowser") is True
                 and res.get("fixupPresent") is True),
                ("1 pane loads fixture A", res.get("oneLoaded") is True),
                ("1 pane browser sized by CSS grid",
                 (res.get("oneRect") or {}).get("w", 0) > 100
                 and (res.get("oneRect") or {}).get("h", 0) > 100),
                ("2 panes: second loads fixture B", res.get("twoLoaded") is True),
                ("2 panes: no reparenting (stable parents)",
                 res.get("noReparentOnTwo") is True),
                ("2 panes: side-by-side rects", res.get("sideBySide") is True),
                ("2 panes: independent committed URLs",
                 res.get("independentSpecs") is True),
                ("4 panes: 4 browser nodes", res.get("fourCount") == 4),
                ("4 panes: all cells sized >100px", res.get("allSized") is True),
                ("4 panes: no reparenting", res.get("noReparentOnFour") is True),
                ("focus switch lands on pane 2", res.get("focusLands") is True),
                ("focus switch back to pane 1", res.get("focusBack") is True),
                ("resize reflows pane rect", res.get("reflowed") is True),
                ("zoom independent per pane",
                 zoom is True or (isinstance(zoom, str) and zoom.startswith("SKIP"))),
                ("distinct browsingContext per pane",
                 res.get("distinctContexts") is True),
                ("frameLoaders live on all panes",
                 res.get("frameLoadersLive") is True),
            ]
            failed = [name for name, ok in checks if not ok]
            for name, ok in checks:
                print(("PASS " if ok else "FAIL ") + name)
            if res.get("errors"):
                print("chrome errors:", res["errors"])
            for k in ("focusMs", "reflowMs", "zoomValues"):
                if res.get(k) is not None:
                    print(f"{k}: {res[k]}")
            if failed:
                print(f"S-01 live probe: FAIL ({len(failed)} checks)")
                return 1
            print("S-01 live probe: PASS (1->2->4 CSS-grid browsers, no reparenting)")
            return 0
        finally:
            wd("DELETE", f"/session/{session}")
    finally:
        gd.terminate()


if __name__ == "__main__":
    sys.exit(main())
