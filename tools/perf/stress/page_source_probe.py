#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P8 probe: the Source page host route reads the page the tab names.

Serves a page with a marker, opens it through the tab model, and calls the
real `PageSource` host module the bridge route points at. Asserts the url and
text belong to that tab and that an unknown tab answers null.
"""
import http.server
import json
import os
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_SOURCE_PORT", "2897"))
MPORT = int(os.environ.get("ASTRA_SOURCE_MARIONETTE", "2898"))
MARKER = "ASTRA-SOURCE-MARKER-7f3c"
PAGE = f"<!doctype html><title>SRC</title><p>{MARKER}</p>"
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

RUN = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 80; i += 1) {
      host = Services.astraHost;
      if (host?.PageSource && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.PageSource) { done(JSON.stringify({ error: "no PageSource host" })); return; }
    const made = await host.Tabs.create({ request_id: "src-open", url: "http://127.0.0.1:__PORT__/src.html" });
    const url = "http://127.0.0.1:__PORT__/src.html";
    let found = null;
    for (let i = 0; i < 60; i += 1) {
      found = await host.PageSource.pageSource({ tab_id: made.astra_tab_id });
      if (found?.text?.includes("__MARKER__")) break;
      await wait(250);
    }
    step("a real page has source", found?.text?.includes("__MARKER__") === true, found?.url);
    step("the source names the tab's url", found?.url === url, found?.url);
    step("the source is not truncated", found?.truncated === false);
    const missing = await host.PageSource.pageSource({ tab_id: "tab-does-not-exist" });
    step("a missing tab is an honest null", missing === null || (missing?.text === "" && missing?.url === ""), missing);
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    httpd = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="astra-src-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
    log = open(os.path.join(profile, "browser.log"), "wb")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    out = {}
    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(240)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 180000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(4)
        out = json.loads(
            m.execute_async(RUN.replace("__PORT__", str(PORT)).replace("__MARKER__", MARKER))
        )
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
        httpd.shutdown()
        if out.get("steps") and all(s["ok"] for s in out["steps"]):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
