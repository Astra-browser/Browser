#!/usr/bin/env python3
"""P1-T10 contract test: content slot + URL bar driven by the Host API stub.

Launches the built Astra binary via the in-tree geckodriver, switches to
Marionette chrome context, and asserts (docs/astra/HOST_API_v1_T10.md):
  - P1-T08 mount intact: #astra-root sized, "Hello Tab" rendered,
    toolbox + tabbox still hidden
  - URL bar present ([data-astra-urlbar] + back/forward/reload buttons)
  - content slot present ([data-astra-content] with a live [data-astra-browser]
    of non-zero size)
  - typing a loopback fixture URL into the URL bar and submitting navigates the
    content browser (Host API stub -> nav.committed -> Content binding)
  - back/forward buttons move through the stub history stack
  - events carry a monotonic event_seq and calls echo request_id

Usage: python3 tests/contract/content_slot.py
Exit 0 on PASS, 1 on FAIL. Stdlib only.
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, "engine")
FIREFOX = os.path.join(ENGINE, "obj-astra-linux", "dist", "bin", "firefox")
GECKODRIVER = os.path.join(ENGINE, "obj-astra-linux", "dist", "host", "bin", "geckodriver")
PORT = 44451

FIXTURES = {
    "a.html": "<html><head><title>Fixture A</title></head>"
              "<body><h1 id='m'>alpha-marker</h1></body></html>",
    "b.html": "<html><head><title>Fixture B</title></head>"
              "<body><h1 id='m'>beta-marker</h1></body></html>",
}


def serve_fixtures():
    """Serve FIXTURES on a loopback ephemeral port.

    The pages must be reachable, so they cannot be file: URLs: since the
    address-box policy (Search.sys.mjs NAVIGABLE = http/https/about) a typed
    file:/javascript:/data:/chrome: URL is searched for, never loaded. A real
    http origin keeps the navigation path under test intact.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            name = self.path.lstrip("/").split("?")[0] or "a.html"
            body = FIXTURES.get(name)
            if body is None:
                self.send_error(404, "no such fixture")
                return
            payload = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]



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
    const q = (s) => d.querySelector(s);
    out.rootChildren = d.getElementById("astra-root")?.childElementCount ?? 0;
    out.rootText = (d.getElementById("astra-root")?.textContent ?? "").slice(0, 200);
    const cs = (id) => {
      const el = d.getElementById(id);
      return el ? win.getComputedStyle(el).display : "MISSING";
    };
    out.toolboxDisplay = cs("navigator-toolbox");
    out.tabboxDisplay = cs("tabbrowser-tabbox");
    out.urlbar = !!q("[data-astra-urlbar]");
    out.backBtn = !!q('[data-astra-urlbar] [data-action="back"]');
    out.fwdBtn = !!q('[data-astra-urlbar] [data-action="forward"]');
    out.reloadBtn = !!q('[data-astra-urlbar] [data-action="reload"]');

    // Drive the WINDOW's Host API instance (P1-T10 seam): the Marionette
    // sandbox would get a separate module evaluation with its own store.
    const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let host = null;
    for (let i = 0; i < 100 && !host; i++) {
      host = win.__astraHost;
      if (!host) { await asleep(100); }
    }
    if (!host) { out.errors.push("no __astraHost seam"); done(out); return; }
    const seqs = [];
    host.addEventListener((e) => seqs.push(e.event_seq));
    const rid = "t10-py-1";
    const nav = await host.Navigation.loadURL({ request_id: rid, url: urlA });
    out.loadEcho = nav.request_id === rid && nav.url === urlA;

    const sleep = asleep;
    const browser = () => q("[data-astra-browser]");
    // Drive the URL bar exactly like a user: type + submit.
    const input = q("[data-astra-urlbar] input");
    const form = q("[data-astra-urlbar] form");
    input.value = urlB;
    input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
    form.requestSubmit();
    let okB = false;
    for (let i = 0; i < 100; i++) {
      const tabs = await host.Tabs.list({});
      const active = (tabs.tabs ?? []).find((t) => t.selected) ?? tabs.tabs[0];
      const spec = (() => { try { return browser()?.currentURI?.spec ?? ""; } catch { return ""; } })();
      if (active?.url === urlB && spec === urlB) { okB = true; break; }
      await sleep(100);
    }
    out.urlbarSubmitNavigates = okB;

    // Back / forward buttons round-trip through stub history [.., urlA, urlB].
    q('[data-astra-urlbar] [data-action="back"]').click();
    let okBack = false;
    for (let i = 0; i < 100; i++) {
      const tabs = await host.Tabs.list({});
      const active = (tabs.tabs ?? []).find((t) => t.selected) ?? tabs.tabs[0];
      const spec = (() => { try { return browser()?.currentURI?.spec ?? ""; } catch { return ""; } })();
      if (active?.url === urlA && spec === urlA) { okBack = true; break; }
      await sleep(100);
    }
    out.backButtonWorks = okBack;
    q('[data-astra-urlbar] [data-action="forward"]').click();
    let okFwd = false;
    for (let i = 0; i < 100; i++) {
      const tabs = await host.Tabs.list({});
      const active = (tabs.tabs ?? []).find((t) => t.selected) ?? tabs.tabs[0];
      const spec = (() => { try { return browser()?.currentURI?.spec ?? ""; } catch { return ""; } })();
      if (active?.url === urlB && spec === urlB) { okFwd = true; break; }
      await sleep(100);
    }
    out.forwardButtonWorks = okFwd;

    const b = browser();
    out.browserPresent = !!b;
    const r = b ? b.getBoundingClientRect() : { width: 0, height: 0 };
    out.browserWidth = r.width;
    out.browserHeight = r.height;
    out.finalSpec = (() => { try { return b?.currentURI?.spec ?? ""; } catch { return ""; } })();
    out.finalTitle = (() => { try { return b?.contentTitle ?? ""; } catch { return ""; } })();
    out.seqsMonotonic = seqs.length > 0 && seqs.every((s, i) => s >= 1 && (i === 0 || s > seqs[i - 1]));
    out.eventCount = seqs.length;
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
            return 1
    server, port = serve_fixtures()
    base = f"http://127.0.0.1:{port}"
    url_a = f"{base}/a.html"
    url_b = f"{base}/b.html"
    print(f"fixtures: {url_a} -> {url_b}")
    profile = tempfile.mkdtemp(prefix="astra-p1t10-prof-")
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
            print("observed:", json.dumps(res, indent=1))
            checks = [
                ("P1-T08 intact: hello still rendered",
                 res.get("rootChildren", 0) > 0 and "Hello Tab" in res.get("rootText", "")),
                ("P1-T08 intact: toolbox hidden", res.get("toolboxDisplay") == "none"),
                ("P1-T08 intact: tabbox hidden", res.get("tabboxDisplay") == "none"),
                ("URL bar present", res.get("urlbar") is True),
                ("back/forward/reload buttons present",
                 res.get("backBtn") is True and res.get("fwdBtn") is True
                 and res.get("reloadBtn") is True),
                ("stub loadURL echoes request_id", res.get("loadEcho") is True),
                ("URL bar submit navigates content browser",
                 res.get("urlbarSubmitNavigates") is True),
                ("back button returns to fixture A", res.get("backButtonWorks") is True),
                ("forward button returns to fixture B",
                 res.get("forwardButtonWorks") is True),
                ("content browser present with size",
                 res.get("browserPresent") is True
                 and res.get("browserWidth", 0) > 100
                 and res.get("browserHeight", 0) > 100),
                ("content browser sits on fixture B", res.get("finalSpec") == url_b),
                ("events monotonic event_seq", res.get("seqsMonotonic") is True),
            ]
            failed = [name for name, ok in checks if not ok]
            for name, ok in checks:
                print(("PASS " if ok else "FAIL ") + name)
            if res.get("errors"):
                print("chrome errors:", res["errors"])
            if res.get("finalTitle"):
                print("content title:", res["finalTitle"])
            if failed:
                print(f"P1-T10 contract: FAIL ({len(failed)} checks)")
                return 1
            print("P1-T10 contract: PASS (content slot + URL bar via Host API stub)")
            return 0
        finally:
            wd("DELETE", f"/session/{session}")
    finally:
        gd.terminate()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
