#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P6b probe: a real geolocation request shows Astra's prompt and resolves.

The page calls `navigator.geolocation.getCurrentPosition`. The shell's
PermissionUI integration must publish `page-permission-prompt-changed`, the
app must render the Astra prompt, a real click on "Allow while visiting the
site" must travel the bridge -> host route -> Permissions.respond path, and
the engine must record the decision in `Services.perms`.

Two loopback origins are used because one origin cannot show two first
prompts: 127.0.0.1 is allowed, localhost is denied.
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
PORT = int(os.environ.get("ASTRA_PERM_PROMPT_PORT", "2871"))
MPORT = int(os.environ.get("ASTRA_PERM_PROMPT_MARIONETTE", "2872"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>ASTRA-PERM-pending</title>
<script>
  navigator.permissions.query({ name: "geolocation" }).then((status) => {
    document.title = "ASTRA-PERM-" + status.state;
    status.onchange = () => {
      document.title = "ASTRA-PERM-" + status.state;
    };
  });
  navigator.geolocation.getCurrentPosition(
    () => { window.__astraGeo = "callback"; },
    () => { window.__astraGeo = "callback"; },
    { timeout: 8000 }
  );
</script>
<p>ASTRA-GEO</p>
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


RUN = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 60; i += 1) {
      host = Services.astraHost;
      if (host?.Permissions) break;
      await wait(250);
    }
    if (!host?.Permissions) {
      done(JSON.stringify({ error: "shell host never published Permissions" }));
      return;
    }
    const seen = [];
    const off = host.addEventListener((event) => {
      if (event?.type === "page-permission-prompt-changed") seen.push(event);
    });
    const shellDoc = document;
    let frame = null;
    for (let i = 0; i < 60; i += 1) {
      frame = shellDoc.querySelector("iframe.astra-app-frame");
      if (frame?.contentDocument?.querySelector("[data-astra-page-permission-prompt]")) break;
      frame = frame ?? shellDoc.querySelector("iframe.astra-app-frame");
      await wait(250);
    }
    if (!frame) {
      off();
      done(JSON.stringify({ error: "no app frame in the shell window" }));
      return;
    }
    const frameDoc = frame.contentDocument;

    const openAndExpect = async (url, label) => {
      const made = await host.Tabs.create({ request_id: `p6b-open-${label}`, url });
      if (made?.error) throw new Error(`tab create failed: ${made.error.message}`);
      const browser = gBrowser.getBrowserForTab(
        gBrowser.tabs[gBrowser.tabs.length - 1]
      );
      let prompt = null;
      for (let i = 0; i < 60; i += 1) {
        const view = host.Permissions.current();
        if (view.prompt) { prompt = view.prompt; break; }
        await wait(250);
      }
      if (!prompt) throw new Error(`no Astra prompt for ${url}`);
      // The app must be showing it, not just the host holding it.
      let rendered = null;
      for (let i = 0; i < 40; i += 1) {
        rendered = frameDoc.querySelector("[data-astra-page-permission-prompt]");
        if (rendered) break;
        await wait(250);
      }
      if (!rendered) throw new Error(`the Astra prompt did not render for ${url}`);
      return { browser, prompt, rendered, astra_tab_id: made.astra_tab_id };
    };

    // --- allow -----------------------------------------------------------
    const allow = await openAndExpect(`http://127.0.0.1:__PORT__/allow.html`, "allow");
    const allowPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(`http://127.0.0.1:__PORT__/allow.html`), {}
    );
    const before = Services.perms.testExactPermissionFromPrincipal(allowPrincipal, "geo");
    step("prompt names geolocation", allow.prompt.kinds.length === 1 && allow.prompt.kinds[0] === "geolocation", allow.prompt.kinds);
    step("prompt names the loopback origin", allow.prompt.origin.includes("127.0.0.1"), allow.prompt.origin);
    step("prompt is rememberable", allow.prompt.rememberable === true);
    step("prompt is fenced to the Astra tab", allow.prompt.item_id === allow.astra_tab_id, [allow.prompt.item_id, allow.astra_tab_id]);
    step("prompt uses the default profile", allow.prompt.profile_id === "default", allow.prompt.profile_id);
    step("prompt starts unknown", before !== Services.perms.ALLOW_ACTION, before);
    const revision = host.Permissions.current().projection_revision;
    step("revision is 32 hex", /^[0-9a-f]{32}$/.test(revision), revision);

    // Real click: the app's own button, through the bridge route.
    await wait(700); // the prompt refuses a click aimed at what it covered
    const buttons = [...allow.rendered.querySelectorAll("button")];
    const allowAlways = buttons.find((b) => (b.textContent ?? "").includes("Allow while visiting"));
    if (!allowAlways) throw new Error(`no allow-always button: ${buttons.map((b) => b.textContent)}`);
    allowAlways.click();
    let closed = false;
    for (let i = 0; i < 60; i += 1) {
      if (!host.Permissions.current().prompt) { closed = true; break; }
      await wait(250);
    }
    step("the prompt closed after the click", closed);
    const after = Services.perms.testExactPermissionFromPrincipal(allowPrincipal, "geo");
    step("Services.perms records the allow", after === Services.perms.ALLOW_ACTION, after);
    let title = "";
    for (let i = 0; i < 60; i += 1) {
      title = allow.browser.contentTitle ?? "";
      if (title === "ASTRA-PERM-granted") break;
      await wait(250);
    }
    step("the page observes granted", title === "ASTRA-PERM-granted", title);

    // --- deny ------------------------------------------------------------
    const deny = await openAndExpect(`http://localhost:__PORT__/deny.html`, "deny");
    step("deny prompt is a different origin", deny.prompt.origin.includes("localhost"), deny.prompt.origin);
    const denyPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(`http://localhost:__PORT__/deny.html`), {}
    );
    await wait(700);
    const denyButtons = [...deny.rendered.querySelectorAll("button")];
    let denyAlways = denyButtons.find((b) => (b.textContent ?? "").includes("Always block"));
    if (!denyAlways) {
      // The app's copy may differ; the durable deny is the last choice.
      const durable = denyButtons.filter((b) => !(b.textContent ?? "").includes("this time"));
      denyAlways = durable[durable.length - 1];
    }
    if (!denyAlways) throw new Error(`no deny button: ${denyButtons.map((b) => b.textContent)}`);
    denyAlways.click();
    let deniedClosed = false;
    for (let i = 0; i < 60; i += 1) {
      if (!host.Permissions.current().prompt) { deniedClosed = true; break; }
      await wait(250);
    }
    step("the deny prompt closed", deniedClosed);
    const deniedState = Services.perms.testExactPermissionFromPrincipal(denyPrincipal, "geo");
    step("Services.perms records the deny", deniedState === Services.perms.DENY_ACTION, deniedState);
    let denyTitle = "";
    for (let i = 0; i < 60; i += 1) {
      denyTitle = deny.browser.contentTitle ?? "";
      if (denyTitle === "ASTRA-PERM-denied") break;
      await wait(250);
    }
    step("the page observes denied", denyTitle === "ASTRA-PERM-denied", denyTitle);

    step("prompt events were published", seen.length >= 4, seen.length);
    step(
      "the first event carried a prompt and the last cleared it",
      seen.length >= 4 && seen[0].data?.prompt !== null && seen[seen.length - 1].data?.prompt === null
    );
    step("no prompt is left waiting", host.Permissions.pending().length === 0, host.Permissions.pending());

    Services.perms.removeFromPrincipal(allowPrincipal, "geo");
    Services.perms.removeFromPrincipal(denyPrincipal, "geo");
    out.ok = out.steps.every((s) => s.ok);
    off();
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


def main():
    httpd = Server(("0.0.0.0", PORT), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    profile = tempfile.mkdtemp(prefix="astra-permprompt-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("geo.provider.use_geoclue", false);\n')
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
        # The probe waits for real UI; every read must outlive the script.
        m.sock.settimeout(300)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 240000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(4)
        out = json.loads(m.execute_async(RUN.replace("__PORT__", str(PORT))))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
        httpd.shutdown()
        if out.get("ok") is True:
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
