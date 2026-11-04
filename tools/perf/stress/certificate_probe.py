#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P6c-2 probe: a refused certificate shows Astra's interstitial.

A loopback HTTPS server uses a self-signed certificate. The probe waits for
the tab failure, asserts the app renders its own failed page (not Firefox's),
continues once, checks the page loads and the temporary override is cleared,
then cancels a second origin and confirms no override was written.
"""
import http.server
import json
import os
import shutil
import signal
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
PORT = int(os.environ.get("ASTRA_CERT_PORT", "2905"))
PORT2 = int(os.environ.get("ASTRA_CERT_PORT2", "2906"))
MPORT = int(os.environ.get("ASTRA_CERT_MARIONETTE", "2907"))
PAGE = "<!doctype html><title>ASTRA-CERT-ok</title><p>secure enough</p>"
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
      if (host?.DialogPrompts && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.DialogPrompts) { done(JSON.stringify({ error: "no DialogPrompts host" })); return; }
    const frameDoc = document.querySelector("iframe.astra-app-frame")?.contentDocument;
    const tabState = async (id) => (await host.Tabs.list({ request_id: "cert-list" })).tabs.find((t) => t.astra_tab_id === id) ?? null;
    const overrides = () => {
      try {
        const service = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
        return service.getOverrides({}).length;
      } catch { return -1; }
    };
    const waitFailure = async (id) => {
      for (let i = 0; i < 80; i += 1) {
        const tab = await tabState(id);
        if (tab?.failure) return tab;
        await wait(250);
      }
      return null;
    };
    const waitTitle = async (browser, wanted) => {
      for (let i = 0; i < 80; i += 1) {
        if ((browser?.contentTitle ?? "") === wanted) return wanted;
        await wait(250);
      }
      return browser?.contentTitle ?? "";
    };

    const made = await host.Tabs.create({ request_id: "cert-open", url: "https://127.0.0.1:__PORT__/" });
    const tab = await waitFailure(made.astra_tab_id);
    step("a refused certificate reaches the tab", !!tab?.failure, tab?.failure);
    step("the failure is a certificate", tab?.failure?.certificate === "untrusted", tab?.failure?.certificate);
    step("the loopback host may continue", tab?.failure?.can_continue === true);
    step("the failure covers the page", tab?.failure?.covers_page === true);
    out.diag = {
      bridge: frameDoc?.documentElement?.dataset?.bridgeMode ?? null,
      ready: document.querySelector("iframe.astra-app-frame")?.dataset?.appReady ?? null,
      rows: frameDoc?.querySelectorAll("[data-astra-tab-id]").length ?? -1,
      hasFailureText: /did not load|certificate|insecure/i.test(frameDoc?.body?.textContent ?? ""),
      appUrl: frameDoc?.querySelector("input")?.value ?? null,
    };
    let errorView = null;
    for (let i = 0; i < 40; i += 1) {
      errorView = frameDoc?.querySelector("[data-astra-navigation-error]");
      if (errorView) break;
      await wait(250);
    }
    step("the app renders its own failed page", !!errorView);
    let stage = "";
    for (let i = 0; i < 40; i += 1) {
      stage = document.documentElement.getAttribute("data-astra-stage") ?? "";
      if (stage !== "page") break;
      await wait(250);
    }
    step("the engine error panel is hidden", stage !== "page", stage);
    step("no override exists yet", overrides() === 0, overrides());

    const continued = await host.DialogPrompts.answerCert({ astra_tab_id: made.astra_tab_id, decision: "proceed-once" });
    step("continue is admitted", continued?.accepted === true, continued);
    const browser = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === made.astra_tab_id)?.linkedBrowser;
    step("the page loads after continue", (await waitTitle(browser, "ASTRA-CERT-ok")) === "ASTRA-CERT-ok", browser?.contentTitle);
    const after = await tabState(made.astra_tab_id);
    step("the failure clears on commit", after?.failure === null, after?.failure);
    step("the page is marked as an exception", after?.certificate_exception === true);
    let cleared = false;
    for (let i = 0; i < 60; i += 1) {
      if (overrides() === 0) { cleared = true; break; }
      await wait(250);
    }
    step("the one-load override is cleared", cleared, overrides());

    const made2 = await host.Tabs.create({ request_id: "cert-open2", url: "https://127.0.0.2:__PORT2__/" });
    const tab2 = await waitFailure(made2.astra_tab_id);
    step("a second certificate error appears", !!tab2?.failure);
    const cancelled = await host.DialogPrompts.answerCert({ astra_tab_id: made2.astra_tab_id, decision: "cancel" });
    step("cancel is admitted", cancelled?.accepted === true, cancelled);
    const after2 = await tabState(made2.astra_tab_id);
    step("cancel keeps the failed page", after2?.failure?.certificate === "untrusted");
    step("cancel writes no override", overrides() === 0, overrides());
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


def make_cert(directory):
    key = os.path.join(directory, "key.pem")
    cert = os.path.join(directory, "cert.pem")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key, "-out", cert, "-days", "1",
            "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1,IP:127.0.0.2",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return cert, key


def main():
    profile = tempfile.mkdtemp(prefix="astra-cert-")
    cert, key = make_cert(profile)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    servers = []
    for address, port in (("127.0.0.1", PORT), ("127.0.0.2", PORT2)):
        server = Server((address, port), Handler)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
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
        script = RUN.replace("__PORT2__", str(PORT2)).replace("__PORT__", str(PORT))
        out = json.loads(m.execute_async(script))
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
        for server in servers:
            server.shutdown()
        if out.get("steps") and all(s["ok"] for s in out["steps"]):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
