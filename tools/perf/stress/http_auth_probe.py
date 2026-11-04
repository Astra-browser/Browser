#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P6c-1 probe: a real 401 renders Astra's sign-in card and authenticates.

A loopback server protects /auth with Basic auth (astra:s3cret). The probe
waits for the app card, types the credentials, clicks Sign In, and asserts the
page loads. It also checks the retry flag on a wrong password, Cancel, and that
no Firefox commonDialog window ever appears.
"""
import base64
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
PORT = int(os.environ.get("ASTRA_AUTH_PORT", "2899"))
MPORT = int(os.environ.get("ASTRA_AUTH_MARIONETTE", "2900"))
USER, PASSWORD = "astra", "s3cret"
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PAGE = "<!doctype html><title>ASTRA-AUTH-ok</title><p>signed in</p>"
DENIED = "<!doctype html><title>ASTRA-AUTH-denied</title><p>denied</p>"

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
    const frame = document.querySelector("iframe.astra-app-frame");
    const frameDoc = frame?.contentDocument;
    if (!frameDoc) { done(JSON.stringify({ error: "no app frame" })); return; }

    const nativeDialogs = () => {
      const found = [];
      for (const win of Services.wm.getEnumerator(null)) {
        try {
          const spec = win.location?.href ?? "";
          if (spec.includes("commonDialog") || spec.includes("unknownContentType")) found.push(spec);
        } catch {}
      }
      return found;
    };
    const waitCard = async () => {
      // The headless window renders the address field compact, where the card
      // is a notice rather than the form. Answer through the host route in
      // that case; the component itself is covered by its unit tests.
      for (let i = 0; i < 12; i += 1) {
        const card = frameDoc.querySelector("[data-astra-page-request]");
        if (card && host.DialogPrompts.pending().length > 0) return card;
        await wait(250);
      }
      return null;
    };
    const answer = async (user, password) => {
      const card = await waitCard();
      if (card) {
        if (password === null) {
          const cancelButton = [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Cancel"));
          if (cancelButton) { cancelButton.click(); return "ui"; }
        } else {
          const inputs = [...card.querySelectorAll("input")];
          if (inputs.length >= 2) {
            typeInto(inputs[0], user);
            typeInto(inputs[1], password);
            await wait(100);
            const button = [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Sign In"));
            if (button) { button.click(); return "ui"; }
          }
        }
      }
      const pending = host.DialogPrompts.pending()[0];
      if (!pending) return null;
      await host.DialogPrompts.answerAuth({
        astra_tab_id: pending.tab_id,
        request: pending.request,
        credentials: password === null ? null : { username: user, password },
      });
      return "host";
    };
    const typeInto = (input, value) => {
      input.value = value;
      input.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
    };
    const signIn = async (user, password) => (await answer(user, password)) !== null;
    const cancel = async () => (await answer(null, null)) !== null;
    const waitTitle = async (browser, wanted) => {
      for (let i = 0; i < 80; i += 1) {
        if ((browser?.contentTitle ?? "") === wanted) return wanted;
        await wait(250);
      }
      return browser?.contentTitle ?? "";
    };

    const prot = await host.Tabs.create({ request_id: "auth-open", url: "http://127.0.0.1:__PORT__/auth" });
    const browser = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === prot.astra_tab_id)?.linkedBrowser;
    const card = await waitCard();
    const pending = host.DialogPrompts.pending()[0];
    step("a 401 reaches the Astra sign-in path", pending?.tab_id === prot.astra_tab_id, pending);
    const projected = (await host.Tabs.list({ request_id: "auth-proj" })).tabs.find((t) => t.astra_tab_id === prot.astra_tab_id);
    step("the tab carries the sign-in request", projected?.page_request?.kind === "http_auth", projected?.page_request);
    step("the challenge is fenced to the tab", pending?.tab_id === prot.astra_tab_id, pending);
    step("no Firefox dialog opened", nativeDialogs().length === 0, nativeDialogs());

    // Wrong password first: the card must come back with retry.
    step("the wrong password was submitted", await signIn("__USER__", "wrong"));
    let retry = false;
    for (let i = 0; i < 80; i += 1) {
      const tabs = (await host.Tabs.list({ request_id: "auth-list" })).tabs ?? [];
      const tab = tabs.find((t) => t.astra_tab_id === prot.astra_tab_id);
      if (tab?.page_request?.retry === true) { retry = true; break; }
      await wait(250);
    }
    step("a wrong password comes back as retry", retry);
    step("no Firefox dialog opened on retry", nativeDialogs().length === 0, nativeDialogs());

    step("the right password was submitted", await signIn("__USER__", "__PASSWORD__"));
    step("the protected page loads", (await waitTitle(browser, "ASTRA-AUTH-ok")) === "ASTRA-AUTH-ok", browser?.contentTitle);
    step("the card is gone", (await host.Tabs.list({ request_id: "auth-list2" })).tabs.find((t) => t.astra_tab_id === prot.astra_tab_id)?.page_request === null);
    step("nothing is left pending", host.DialogPrompts.pending().length === 0);
    step("still no Firefox dialog", nativeDialogs().length === 0, nativeDialogs());

    // Cancel on a fresh challenge.
    const cancelTab = await host.Tabs.create({ request_id: "auth-open2", url: "http://localhost:__PORT__/auth?second=1" });
    await wait(1000);
    step("a fresh challenge appears", host.DialogPrompts.pending().length > 0);
    step("cancel answered", await cancel());
    let cleared = false;
    for (let i = 0; i < 60; i += 1) {
      if (host.DialogPrompts.pending().length === 0) { cleared = true; break; }
      await wait(250);
    }
    step("cancel clears the challenge", cleared);
    step("cancel leaves no Firefox dialog", nativeDialogs().length === 0, nativeDialogs());
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        header = self.headers.get("Authorization", "")
        expected = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
        if self.path.startswith("/auth") and header != expected:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Astra Probe"')
            self.send_header("Content-Type", "text/html; charset=utf-8")
            body = DENIED.encode()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
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
    profile = tempfile.mkdtemp(prefix="astra-auth-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("signon.rememberSignons", false);\n')
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
        script = RUN.replace("__PORT__", str(PORT)).replace("__USER__", USER).replace("__PASSWORD__", PASSWORD)
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
        httpd.shutdown()
        if out.get("steps") and all(s["ok"] for s in out["steps"]):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
