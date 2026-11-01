#!/usr/bin/env python3
"""P1-T11 contract-test harness: geckodriver/Marionette boots Astra.

What it proves (docs: tests/contract/README.md):
  1. The built binary launches headless with a fresh profile via the
     in-tree geckodriver (binary paths from docs/astra/BUILD_TIMES.md).
  2. Marionette chrome context works: chrome://astra/content/hello.html
     loads and its window title carries Astra branding.
  3. The Host API seam answers: resource://astra HostAPI.sys.mjs exports
     HOST_API_VERSION == 1 and Boot.handshake() echoes request_id.
  4. A local fixture page (tests/fixtures/) loads via WebDriver navigate
     and its DOM marker reads back.

Runner choice: Python stdlib (not Bun/Go). Justification: the P1-T06/P1-T08
contract tests already prove this exact geckodriver + Marionette pattern
against this binary with zero dependencies, so the harness adds no
toolchain to CI. Bun would buy nothing here (no UI to bundle).

Modes:
  run.py               full contract (needs built binary + geckodriver)
  run.py --smoke       fast subset: fixture load + chrome://astra title only
  run.py --fixture-only  no browser: serve fixtures, assert over plain HTTP.
                       Proves the harness works where no build exists (CI).

Exit codes: 0 PASS, 1 FAIL, 2 SKIP (binary/geckodriver absent; only in
browser modes — --fixture-only never skips). Artifacts (geckodriver.log,
results.json) go to out/contract-p1t11-<UTC timestamp>/.
"""
import datetime
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, "engine")
OBJDIR = os.path.join(ENGINE, "obj-astra-linux")
FIREFOX = os.environ.get("ASTRA_BINARY", os.path.join(OBJDIR, "dist", "bin", "firefox"))
GECKODRIVER = os.environ.get(
    "ASTRA_GECKODRIVER", os.path.join(OBJDIR, "dist", "host", "bin", "geckodriver")
)
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
FIXTURE_FILE = "astra-smoke.html"
FIXTURE_TITLE = "Astra Contract Fixture"
FIXTURE_MARKER = "ASTRA-FIXTURE-OK"
HELLO_URL = "chrome://astra/content/hello.html"
# NOTE: the provider segment is mandatory. chrome:// URLs are
# chrome://PACKAGE/PROVIDER/PATH (provider = content|skin|locale;
# engine/chrome/nsChromeRegistry.cpp GetBaseURIFromPackage). The bare
# "chrome://astra/hello.html" form used in older docs never resolves
# (convertChromeURL -> NS_ERROR_FILE_NOT_FOUND, WebDriver navigate hangs).
HELLO_TITLE = "Astra \u2014 Hello Tab"

PORT = int(os.environ.get("ASTRA_WD_PORT", "44451"))


def log(art, msg):
    print(msg, flush=True)
    art.append(msg)


class Artifacts:
    """Artifact sink: out/contract-p1t11-<ts>/ (gitignored via out/)."""

    def __init__(self):
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.dir = os.path.join(ROOT, "out", f"contract-p1t11-{ts}")
        os.makedirs(self.dir, exist_ok=True)
        self.lines = []

    def note(self, msg):
        print(msg, flush=True)
        self.lines.append(msg)

    def write_results(self, status, checks):
        payload = {
            "status": status,
            "checks": checks,
            "firefox": FIREFOX,
            "geckodriver": GECKODRIVER,
        }
        with open(os.path.join(self.dir, "results.json"), "w") as f:
            json.dump(payload, f, indent=1)
        with open(os.path.join(self.dir, "console.log"), "w") as f:
            f.write("\n".join(self.lines) + "\n")
        self.note(f"artifacts: {self.dir}")


def make_wd(base):
    def wd(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)["value"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}")

    return wd


class FixtureServer:
    """Loopback static server for tests/fixtures/ (stdlib http.server)."""

    def __init__(self):
        handler = functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=FIXTURES
        )
        # Suppress per-request stderr noise; failures surface via asserts.
        handler.log_message = lambda *a: None
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.thread.join(timeout=10)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/{FIXTURE_FILE}"


def wait_ready(wd):
    for _ in range(100):
        try:
            wd("GET", "/status")
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("geckodriver /status never came up")


def wait_driven(wd, session):
    # Marionette must be driving the browser before leaving content
    # context (else geckodriver answers 500) — same probe as P1-T06.
    for _ in range(100):
        try:
            wd("GET", f"/session/{session}/title")
            return
        except RuntimeError:
            time.sleep(0.3)
    raise RuntimeError("browser never became driven")


def new_session(wd):
    profile = tempfile.mkdtemp(prefix="astra-p1t11-")
    session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {
        "moz:firefoxOptions": {
            "binary": FIREFOX,
            "args": ["--headless", "--no-remote",
                     "-remote-allow-system-access",
                     "--profile", profile],
        }}}})["sessionId"]
    return session, profile


def check_fixture_only(art):
    """No-browser self-test: serve fixtures, assert over plain HTTP."""
    with FixtureServer() as srv:
        art.note(f"fixture server: {srv.url}")
        try:
            with urllib.request.urlopen(srv.url, timeout=10) as r:
                status, body = r.status, r.read().decode()
        except OSError as e:
            art.note(f"FAIL fixture fetch: {e}")
            return 1
        checks = [
            ("fixture HTTP 200", status == 200),
            ("fixture title present", f"<title>{FIXTURE_TITLE}</title>" in body),
            ("fixture marker present", FIXTURE_MARKER in body),
        ]
        failed = [n for n, ok in checks if not ok]
        for n, ok in checks:
            art.note(("PASS " if ok else "FAIL ") + n)
        art.write_results("PASS" if not failed else "FAIL", checks)
        return 0 if not failed else 1


OPEN_TAB_SCRIPT = """const S = (typeof Services !== "undefined") ? Services
      : ChromeUtils.importESModule(
      "resource://gre/modules/Services.sys.mjs").Services;
    const win = S.wm.getMostRecentWindow("navigator:browser");
    const tab = win.gBrowser.addTab("chrome://astra/content/hello.html",
      { triggeringPrincipal: S.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = tab;
    return win.gBrowser.tabs.length;"""

BRANDING_SCRIPT = """const S = (typeof Services !== "undefined") ? Services
      : ChromeUtils.importESModule(
      "resource://gre/modules/Services.sys.mjs").Services;
    const win = S.wm.getMostRecentWindow("navigator:browser");
    return {
      appName: S.appinfo.name,
      appVendor: S.appinfo.vendor,
      winTitle: win ? win.document.title : null,
    };"""

HOST_API_SCRIPT = """return (async () => {
    const m = await ChromeUtils.importESModule(
      "resource://astra/host/HostAPI.sys.mjs");
    const hs = await m.Boot.handshake({ request_id: "p1t11" });
    return {
      version: m.HOST_API_VERSION,
      echo: hs.request_id,
      hostVersion: hs.host_api_version,
    };
  })();"""


def display_name():
    """Dev display name from branding/astra.toml (D-19 single source)."""
    try:
        with open(os.path.join(ROOT, "branding", "astra.toml")) as f:
            for line in f:
                line = line.split("#")[0].strip()
                if line.startswith("display_name"):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return "Astra"


def run_browser(art, smoke):
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            art.note(f"SKIP: missing {f} (run a full build first)")
            return 2
    if not os.path.exists(os.path.join(FIXTURES, FIXTURE_FILE)):
        art.note(f"FAIL: fixture missing: {FIXTURES}/{FIXTURE_FILE}")
        return 1

    checks = []
    gd_log = open(os.path.join(art.dir, "geckodriver.log"), "w")
    gd = subprocess.Popen(
        [GECKODRIVER, "--port", str(PORT)],
        stdout=gd_log, stderr=subprocess.STDOUT,
    )
    try:
        wd = make_wd(f"http://127.0.0.1:{PORT}")
        try:
            wait_ready(wd)
        except RuntimeError as e:
            art.note(f"FAIL {e}")
            return 1
        session, profile = new_session(wd)
        try:
            wait_driven(wd, session)

            # --- 1. local fixture page via WebDriver navigate (content) ---
            with FixtureServer() as srv:
                art.note(f"fixture server: {srv.url}")
                wd("POST", f"/session/{session}/url", {"url": srv.url})
                title = wd("GET", f"/session/{session}/title")
                marker = wd("POST", f"/session/{session}/execute/sync", {
                    "script": "return document.getElementById('astra-fixture-ok')"
                              " ? document.getElementById('astra-fixture-ok').textContent : null;",
                    "args": [],
                })
                art.note(f"observed fixture: title={title!r} marker={marker!r}")
                checks.append(("fixture title", title == FIXTURE_TITLE))
                checks.append(("fixture marker", marker == FIXTURE_MARKER))

            # --- 2. chrome://astra/ loads, title carries Astra branding ---
            # NOTE: WebDriver `navigate` to a chrome:// URL hangs
            # geckodriver (observed 2026-11-01: POST /url never answers).
            # Open the page from chrome context instead: gBrowser.addTab
            # with the system principal, then read it as content.
            wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
            ntabs = wd("POST", f"/session/{session}/execute/sync",
                       {"script": OPEN_TAB_SCRIPT, "args": []})
            wd("POST", f"/session/{session}/moz/context", {"context": "content"})
            # The new tab is a new window handle; the session stays on the
            # old one until we switch (Marionette does not follow
            # selectedTab set from chrome scope).
            hello_title, hello_badge = "", None
            for h in wd("GET", f"/session/{session}/window/handles"):
                wd("POST", f"/session/{session}/window", {"handle": h})
                for _ in range(40):
                    t = wd("GET", f"/session/{session}/title")
                    if t == HELLO_TITLE:
                        break
                    time.sleep(0.3)
                if t == HELLO_TITLE:
                    hello_title = t
                    hello_badge = wd("POST", f"/session/{session}/execute/sync", {
                        "script": "return document.body ? document.body.textContent.slice(0, 200) : null;",
                        "args": [],
                    })
                    break
            art.note(f"observed hello: tabs={ntabs} title={hello_title!r}")
            checks.append(("chrome://astra/content/hello.html loads (title has Astra)",
                           hello_title == HELLO_TITLE))
            checks.append(("hello page badge text",
                           isinstance(hello_badge, str) and "chrome://astra/" in hello_badge))

            # --- 3+4. chrome context: branding record + Host API version ---
            # (skipped in --smoke: boot + navigate already prove the seam)
            if not smoke:
                wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
                brand = wd("POST", f"/session/{session}/execute/sync",
                           {"script": BRANDING_SCRIPT, "args": []})
                art.note(f"observed branding: {json.dumps(brand)}")
                checks.append(("appinfo present",
                               bool(brand.get("appName"))))
                # Dev builds use unofficial branding (BUILD_TIMES.md), so the
                # binary name reads "Firefox"; release builds with astra
                # branding must read the display name. Either is a PASS here
                # with the expectation recorded; anything else FAILs.
                want = display_name()
                name = brand.get("appName") or ""
                if want in name:
                    art.note(f"branding: binary name carries {want!r}")
                    checks.append(("binary branding", True))
                elif name == "Firefox":
                    art.note("branding: WARN binary is unofficial dev branding"
                             " (expected until release branding lands; see README)")
                    checks.append(("binary branding (unofficial dev, recorded)", True))
                else:
                    checks.append((f"binary branding (want {want!r} or Firefox)", False))

                api = wd("POST", f"/session/{session}/execute/sync",
                         {"script": HOST_API_SCRIPT, "args": []})
                art.note(f"observed host api: {json.dumps(api)}")
                checks.append(("HOST_API_VERSION == 1", api.get("version") == 1))
                checks.append(("handshake echoes request_id",
                               api.get("echo") == "p1t11" and api.get("hostVersion") == 1))

            failed = [n for n, ok in checks if not ok]
            for n, ok in checks:
                art.note(("PASS " if ok else "FAIL ") + n)
            art.write_results("PASS" if not failed else "FAIL", checks)
            if failed:
                art.note(f"P1-T11 contract: FAIL ({len(failed)} checks)")
                return 1
            art.note("P1-T11 contract: PASS")
            return 0
        except Exception as e:
            art.note(f"FAIL harness error: {e!r}")
            checks.append(("harness completed without error", False))
            art.write_results("FAIL", checks)
            art.note("P1-T11 contract: FAIL (harness error)")
            return 1
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


def main(argv):
    art = Artifacts()
    mode = argv[1] if len(argv) > 1 else "full"
    if mode == "--fixture-only":
        rc = check_fixture_only(art)
    elif mode == "--smoke":
        rc = run_browser(art, smoke=True)
    elif mode in ("--full", "full"):
        rc = run_browser(art, smoke=False)
    else:
        print(f"usage: run.py [--full|--smoke|--fixture-only]", file=sys.stderr)
        return 2
    if rc == 2:
        art.write_results("SKIP", [])
        art.note("P1-T11 contract: SKIP (build binary absent)")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
