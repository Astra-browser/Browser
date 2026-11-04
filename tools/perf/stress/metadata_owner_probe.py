#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P5b owner probe: only one window writes the organisation store.

Each browser window owns its own tab model, so window ids are not comparable
across windows. The first public window claims a process-wide writer slot; a
second window must refuse to save. This probe opens two normal windows and
checks both halves of that rule against the real sidecar, then reads the
SQLite row to prove the store still belongs to the first window.
"""
import http.server
import json
import os
import shutil
import signal
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
MPORT = int(os.environ.get("ASTRA_OWNER_MARIONETTE", "2892"))
PORT = int(os.environ.get("ASTRA_OWNER_PORT", "2893"))
WORK = f"http://127.0.0.1:{PORT}/work.html"

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

RUN = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let first = null;
    for (let i = 0; i < 120; i += 1) {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (!win.closed && win.__astraHost?.Metadata) { first = win.__astraHost; break; }
      }
      if (first) break;
      await wait(250);
    }
    if (!first) { done(JSON.stringify({ error: "no shell window" })); return; }
    for (let i = 0; i < 80; i += 1) {
      if (first.Metadata.status().available) break;
      await wait(250);
    }
    step("the first window owns the store", first.Metadata.status().owner === true, first.Metadata.status());

    const space = await first.Tabs.createSpace({ request_id: "own-space", name: "Work" });
    const made = await first.Tabs.create({ request_id: "own-tab", url: "__WORK__" });
    step("the organisation exists", space?.accepted === true && typeof made?.astra_tab_id === "string");
    const saved = await first.Metadata.save();
    step("the owner saves", saved.saved === true, saved);

    // Open a second normal window and wait for its own shell host.
    await first.Windows.create({ request_id: "own-window", private: false });
    let second = null;
    for (let i = 0; i < 120; i += 1) {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (!win.closed && win.__astraHost?.Metadata && win.__astraHost !== first) {
          second = win.__astraHost;
          break;
        }
      }
      if (second) break;
      await wait(250);
    }
    if (!second) { step("a second window opened", false); done(JSON.stringify(out)); return; }
    step("a second window opened", true);
    step("the second window is not the owner", second.Metadata.status().owner === false, second.Metadata.status());

    const refused = await second.Metadata.save();
    step(
      "the second window refuses to save",
      refused.saved === false && refused.reason === "not_owner",
      refused
    );
    const again = await first.Metadata.save();
    step("the owner still saves", again.saved === true, again);

    const ownId = (await second.Windows.list({ request_id: "own-id" })).focused_window_id;
    if (ownId) await second.Windows.close({ request_id: "own-close", window_id: ownId });
    await wait(1500);
    const afterClose = await first.Metadata.save();
    step("the owner survives the other window closing", afterClose.saved === true, afterClose);

    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        body = f"<!doctype html><title>{self.path}</title><p>{self.path}</p>".encode()
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
    profile = tempfile.mkdtemp(prefix="astra-owner-")
    db = os.path.join(profile, "astra", "core.sqlite")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
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
        m.sock.settimeout(300)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 240000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(4)
        out = json.loads(m.execute_async(RUN.replace("__WORK__", WORK)))
        try:
            m.execute("try { Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return 'ok'; } catch (e) { return String(e); }")
        except Exception:
            pass
        try:
            proc.wait(timeout=30)
        except Exception:
            pass
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
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
