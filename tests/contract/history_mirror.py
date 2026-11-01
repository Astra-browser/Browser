#!/usr/bin/env python3
"""P2-T07 contract test: History mirror into Places, live browser (U-06).

Boots the built Astra binary via the in-tree geckodriver (same harness
shape as content_slot.py), imports overlay/astra/host/History.sys.mjs in
chrome via a test-only resource substitution (no packaging change needed),
mirrors a visit through the LIVE Places backend, then proves the :visited
styling precondition through the styling engine's own query
(mozIAsyncHistory.isURIVisited — the exact VisitedQuery Link.cpp runs per
link before painting :visited; bug 147777 forbids content JS from observing
:visited, and this environment has no mappable framebuffer for pixel
snapshots, so the engine query is the strongest observable signal):

  - History.visit(http fixture URL) -> mirrored:true (live Places insert)
  - History.isVisited -> true
  - isURIVisited(mirror URL) true; real-load URL true (parity); control false
  - History.clear() -> cleared; isURIVisited false for all three

Usage: python3 tests/contract/history_mirror.py
Env overrides: ASTRA_BINARY, ASTRA_GECKODRIVER, ASTRA_WD_PORT,
  ASTRA_HISTORY_MODULE (file:// or path to History.sys.mjs under test).
Exit 0 PASS, 1 FAIL, 2 SKIP (binary/geckodriver absent). Stdlib only.
"""
import functools
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
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine"))
FIREFOX = os.environ.get(
    "ASTRA_BINARY",
    os.path.join(ENGINE, "obj-astra-linux", "dist", "bin", "firefox"),
)
GECKODRIVER = os.environ.get(
    "ASTRA_GECKODRIVER",
    os.path.join(ENGINE, "obj-astra-linux", "dist", "host", "bin", "geckodriver"),
)
PORT = int(os.environ.get("ASTRA_WD_PORT", "44452"))
MODULE = os.environ.get(
    "ASTRA_HISTORY_MODULE",
    os.path.join(ROOT, "overlay", "astra", "host", "History.sys.mjs"),
)
if MODULE.startswith("file://"):
    MODULE = MODULE[len("file://"):]


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


# The module under test is imported in chrome from its real file via a
# test-only resource substitution (resource://astra-history-test/ -> the
# module's directory on disk), because ChromeUtils.importESModule only
# trusts resource://chrome:// URLs and this lane owns neither jar.mn
# registration nor the HostAPI facade (P2-T06). No file is copied: the
# engine loads the exact bytes under test. The live Places backend is
# reached via dynamic import("resource://gre/...").
CHROME_VISIT = """
const done = arguments[arguments.length - 1];
const [moduleDir, moduleFile, url, title] = arguments;
(async () => {
  const out = {};
  try {
    const resHandler = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    resHandler.setSubstitution("astra-history-test",
      Services.io.newURI("file://" + moduleDir));
    const mod = ChromeUtils.importESModule(
      "resource://astra-history-test/" + moduleFile);
    const r1 = await mod.History.visit({ request_id: "live-visit-1", url, title });
    out.visitEcho = r1.request_id === "live-visit-1";
    out.visitVersion = r1.host_api_version;
    out.mirrored = r1.mirrored === true;
    out.mirrorError = r1.error || null;
    const r2 = await mod.History.isVisited({ request_id: "live-seen-1", url });
    out.isVisited = r2.visited === true;
    // Live-backend check: the real Places store answers, not a stub.
    const PlacesHistory = ChromeUtils.importESModule(
      "resource://gre/modules/History.sys.mjs").History;
    const page = await PlacesHistory.fetch(url);
    out.placesHasPage = !!page;
    out.placesTitle = page ? page.title : null;
    // Styling-engine check: the exact visited query behind :visited paint.
    const histSvc = Cc["@mozilla.org/browser/history;1"]
      .getService(Ci.mozIAsyncHistory);
    out.engineVisited = await new Promise((resolve, reject) => {
      try {
        histSvc.isURIVisited(Services.io.newURI(url), (uri, visited) => {
          resolve(!!visited);
        });
      } catch (e) { reject(e); }
    });
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  done(out);
}).call(this);
"""

CHROME_STATUS = """
const done = arguments[arguments.length - 1];
const [moduleDir, moduleFile, urls] = arguments;
(async () => {
  const out = { engine: {}, fetch: {} };
  try {
    const resHandler = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    resHandler.setSubstitution("astra-history-test",
      Services.io.newURI("file://" + moduleDir));
    const mod = ChromeUtils.importESModule(
      "resource://astra-history-test/" + moduleFile);
    const PlacesHistory = ChromeUtils.importESModule(
      "resource://gre/modules/History.sys.mjs").History;
    const histSvc = Cc["@mozilla.org/browser/history;1"]
      .getService(Ci.mozIAsyncHistory);
    for (const u of urls) {
      const seen = await mod.History.isVisited({ url: u });
      out.fetch[u] = seen.visited === true;
      out.engine[u] = await new Promise((resolve, reject) => {
        try {
          histSvc.isURIVisited(Services.io.newURI(u), (uri, visited) => {
            resolve(!!visited);
          });
        } catch (e) { reject(e); }
      });
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  done(out);
}).call(this);
"""

CHROME_CLEAR = """
const done = arguments[arguments.length - 1];
const [moduleDir, moduleFile, url] = arguments;
(async () => {
  const out = {};
  try {
    const resHandler = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    resHandler.setSubstitution("astra-history-test",
      Services.io.newURI("file://" + moduleDir));
    const mod = ChromeUtils.importESModule(
      "resource://astra-history-test/" + moduleFile);
    const r = await mod.History.clear({ request_id: "live-clear-1" });
    out.clearEcho = r.request_id === "live-clear-1";
    out.cleared = r.cleared === true;
    const seen = await mod.History.isVisited({ url });
    out.isVisitedAfterClear = seen.visited === true;
    const PlacesHistory = ChromeUtils.importESModule(
      "resource://gre/modules/History.sys.mjs").History;
    out.placesHasPageAfterClear = !!(await PlacesHistory.fetch(url));
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  done(out);
}).call(this);
"""

# Styling probe: the styling engine's own visited query (bug 147777 note).
# Content JS is forbidden from observing :visited (querySelector/matches/
# computed style all lie by design, and this environment cannot capture
# pixels: SWGL has no mappable framebuffer headless). So this harness asks,
# from chrome, the exact question the painter asks per link: Link.cpp ->
# IHistory::RegisterVisitedCallback -> parent VisitedQuery
# (SELECT url, last_visit_date NOTNULL FROM moz_places ...), exposed to JS as
# mozIAsyncHistory.isURIVisited on @mozilla.org/browser/history;1.
# A mirror-inserted visit must answer identically to a real-load visit.
def engine_status(session, module_dir, module_file, urls):
    wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
    return wd("POST", f"/session/{session}/execute/async",
              {"script": CHROME_STATUS,
               "args": [module_dir, module_file, list(urls)]})

# Content probe context: the fixture page is loaded as the top-level
# content document via plain WebDriver navigation (the Astra shell lives in
# chrome and is unaffected). Ready-state wait before probing.
CONTENT_READY = "return document.readyState;"


def main():
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            print(f"SKIP: missing {f} (run a full build first)")
            return 2
    if not os.path.exists(MODULE.replace("file://", "")):
        print(f"SKIP: missing History module {MODULE}")
        return 2

    tmp = tempfile.mkdtemp(prefix="astra-p2t07-")
    with open(os.path.join(tmp, "visited.html"), "w") as f:
        f.write("<html><head><title>Visited Fixture</title></head>"
                "<body><h1>visited-marker</h1></body></html>")
    with open(os.path.join(tmp, "control.html"), "w") as f:
        f.write("<html><head><title>Control Fixture</title></head>"
                "<body><h1>control-marker</h1></body></html>")

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    fport = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    visited_url = f"http://127.0.0.1:{fport}/visited.html"
    loaded_url = f"http://127.0.0.1:{fport}/loaded.html"
    control_url = f"http://127.0.0.1:{fport}/control.html"
    with open(os.path.join(tmp, "loaded.html"), "w") as f:
        f.write("<html><head><title>Loaded Fixture</title></head>"
                "<body><h1>loaded-marker</h1></body></html>")
    with open(os.path.join(tmp, "index.html"), "w") as f:
        # Fixture index linking all three URLs (for manual headed runs where
        # pixels can be captured; the automated checks use isURIVisited).
        f.write("<html><head><title>History Fixture</title><style>"
                ":link { color: rgb(0, 0, 255); } "
                ":visited { color: rgb(128, 0, 128); } "
                "body { background: white; font-size: 48px; } "
                "a { display: block; }</style></head><body>"
                f"<a id='visited-link' href='{visited_url}'>MIRRORVISITLINK</a>"
                f"<a id='loaded-link' href='{loaded_url}'>REALLOADLINK</a>"
                f"<a id='control-link' href='{control_url}'>CONTROLLINK</a>"
                "</body></html>")
    index_url = f"http://127.0.0.1:{fport}/index.html"
    module_dir = os.path.dirname(MODULE) + "/"
    module_file = os.path.basename(MODULE)

    profile = tempfile.mkdtemp(prefix="astra-p2t07-prof-")
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
            wd("POST", f"/session/{session}/timeouts", {"script": 60000})

            def chrome_async(script, *args):
                wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
                return wd("POST", f"/session/{session}/execute/async",
                           {"script": script, "args": list(args)})

            # 1. Mirror a visit through the LIVE Places backend.
            v = chrome_async(CHROME_VISIT, module_dir, module_file, visited_url,
                             "Visited Fixture")
            print("visit observed:", json.dumps(v, indent=1))

            # 2. Positive control: a real load of a second fixture URL.
            # (WebDriver navigate only works in content context; the Astra
            # shell lives in chrome and is unaffected.)
            wd("POST", f"/session/{session}/moz/context", {"context": "content"})
            wd("POST", f"/session/{session}/url", {"url": loaded_url})
            loaded_real = False
            for _ in range(100):
                try:
                    state = wd("POST", f"/session/{session}/execute/sync",
                               {"script": CONTENT_READY, "args": []})
                    title = wd("GET", f"/session/{session}/title")
                    if state == "complete" and title == "Loaded Fixture":
                        loaded_real = True
                        break
                except RuntimeError:
                    pass
                time.sleep(0.2)
            print("real-load observed:", json.dumps({"loaded": loaded_real}, indent=1))

            # 3. Ask the styling engine's own question for all three URLs.
            st_visit = engine_status(session, module_dir, module_file,
                                     [visited_url, loaded_url, control_url])
            print("engine-status-after-visit:", json.dumps(st_visit, indent=1))

            # 4. Clear the mirror, ask again.
            c = chrome_async(CHROME_CLEAR, module_dir, module_file, visited_url)
            print("clear observed:", json.dumps(c, indent=1))
            st_clear = engine_status(session, module_dir, module_file,
                                     [visited_url, loaded_url, control_url])
            print("engine-status-after-clear:", json.dumps(st_clear, indent=1))

            eng_v = (st_visit.get("engine") or {}).get(visited_url) is True
            eng_l = (st_visit.get("engine") or {}).get(loaded_url) is True
            eng_c_v = (st_visit.get("engine") or {}).get(control_url) is False
            eng_v_c = (st_clear.get("engine") or {}).get(visited_url) is False
            eng_l_c = (st_clear.get("engine") or {}).get(loaded_url) is False
            eng_c_c = (st_clear.get("engine") or {}).get(control_url) is False
            checks = [
                ("live visit echoes request_id + v1", v.get("visitEcho") is True
                 and v.get("visitVersion") == 1),
                ("live visit mirrored into Places", v.get("mirrored") is True
                 and v.get("placesHasPage") is True),
                ("mirror isVisited true after visit", v.get("isVisited") is True),
                ("styling engine: mirror-inserted URL counts visited",
                 v.get("engineVisited") is True and eng_v),
                ("styling engine: real-load URL counts visited (parity)",
                 eng_l),
                ("styling engine: untouched URL counts unvisited", eng_c_v),
                ("real load of fixture works", loaded_real is True),
                ("clear echoes + reports cleared", c.get("clearEcho") is True
                 and c.get("cleared") is True),
                ("Places empty after clear", c.get("placesHasPageAfterClear") is False),
                ("styling engine: all URLs unvisited after clear",
                 eng_v_c and eng_l_c and eng_c_c),
            ]
            failed = [name for name, k in checks if not k]
            for name, k in checks:
                print(("PASS " if k else "FAIL ") + name)
            for tag, blob in (("visit", v), ("status-visit", st_visit),
                              ("clear", c), ("status-clear", st_clear)):
                if isinstance(blob, dict) and blob.get("error"):
                    print(f"{tag} error:", blob["error"])
            return 0 if not failed else 1
        finally:
            try:
                wd("DELETE", f"/session/{session}")
            except Exception:
                pass
    finally:
        gd.terminate()
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
