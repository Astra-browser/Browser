#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""ASTRA-0011 probe: `navigator.getBattery()` is reachable from web content.

Upstream marks the binding ChromeOnly to stop battery fingerprinting. This
probe proves the patch: a normal http page sees the method, the returned
promise resolves to the engine's BatteryManager, the level is a fraction and
`charging` is a boolean. On a host with no battery backend the HAL fallback
reports level 1.0 / charging true, which is still a real engine answer.

The site that raised the report (checkmydevice.app/battery-test) shows
UNSUPPORTED when `navigator.getBattery` is absent; this is the exact check.
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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
PORT = int(os.environ.get("ASTRA_BATTERY_PORT", "2891"))
MPORT = int(os.environ.get("ASTRA_BATTERY_MARIONETTE", "2892"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>ASTRA-BAT-pending</title>
<script>
  window.__astraBattery = "pending";
  if (typeof navigator.getBattery !== "function") {
    window.__astraBattery = "absent";
    document.title = "ASTRA-BAT-absent";
  } else {
    navigator.getBattery().then((battery) => {
      const report = {
        level: battery.level,
        charging: battery.charging,
        chargingTime: battery.chargingTime,
        dischargingTime: battery.dischargingTime,
        events: typeof battery.addEventListener === "function",
        sameOnSecondCall: false,
      };
      return navigator.getBattery().then((again) => {
        report.sameOnSecondCall = again === battery;
        window.__astraBattery = report;
        document.title =
          "ASTRA-BAT|" +
          [
            report.level,
            report.charging,
            report.chargingTime,
            report.dischargingTime,
            report.events,
            report.sameOnSecondCall,
          ].join("|");
      });
    }).catch((error) => {
      window.__astraBattery = "error:" + (error && error.name);
      document.title = "ASTRA-BAT-error-" + (error && error.name);
    });
  }
</script>
<p>ASTRA-BATTERY</p>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        payload = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


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
      if (host?.Tabs) break;
      await wait(250);
    }
    if (!host?.Tabs) { done(JSON.stringify({ error: "no shell host" })); return; }
    const made = await host.Tabs.create({ request_id: "battery", url: "http://127.0.0.1:__PORT__/battery" });
    if (made?.error) throw new Error(`tab create failed: ${made.error.message}`);
    await wait(500);
    const tab = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === made.astra_tab_id);
    const browser = tab?.linkedBrowser ?? null;
    if (!browser) { done(JSON.stringify({ error: "no browser for the tab" })); return; }
    let title = "";
    for (let i = 0; i < 80; i += 1) {
      title = browser.contentTitle ?? "";
      if (title.startsWith("ASTRA-BAT-") || title.startsWith("ASTRA-BAT|")) break;
      await wait(250);
    }
    const fields = title.startsWith("ASTRA-BAT|") ? title.slice("ASTRA-BAT|".length).split("|") : [];
    step("the page resolved the battery read", fields.length === 6, title);
    step("level is a fraction", Number.isFinite(Number(fields[0])) && Number(fields[0]) >= 0 && Number(fields[0]) <= 1, fields[0]);
    step("charging is a boolean", fields[1] === "true" || fields[1] === "false", fields[1]);
    step("chargingTime is a number", Number.isFinite(Number(fields[2])), fields[2]);
    step("dischargingTime is a number or Infinity while charging", fields[3] === "Infinity" || Number.isFinite(Number(fields[3])), fields[3]);
    step("the object is a BatteryManager with events", fields[4] === "true", fields[4]);
    step("the second read is the same manager", fields[5] === "true", fields[5]);
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


def main():
    server = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="astra-battery-")
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
        out = json.loads(m.execute_async(RUN.replace("__PORT__", str(PORT))))
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
        server.shutdown()
        if out.get("steps") and all(s["ok"] for s in out["steps"]):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
