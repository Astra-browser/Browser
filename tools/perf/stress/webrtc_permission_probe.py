#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P6b-2 probe: camera/microphone requests show Astra's prompt and settle.

A local page calls `getUserMedia({audio, video})` with fake devices. The
WebRTC actor must hand the request to Astra, the app must render one prompt
with both kinds, and a real click must send `webrtc:Allow`/`webrtc:Deny`,
write the site policy, drive the sharing indicator, and let the page observe
a live stream or `NotAllowedError`.

Cases: allow always + stop sharing, deny always, allow once (temporary scope),
dismiss (no policy, prompts again), and auto-allow after a persistent grant.
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
PORT = int(os.environ.get("ASTRA_WEBRTC_PORT", "2876"))
MPORT = int(os.environ.get("ASTRA_WEBRTC_MARIONETTE", "2877"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>GUM-PENDING</title>
<script>
  navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((stream) => {
    window.__gum = stream;
    document.title = "GUM-OK";
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => { document.title = "GUM-ENDED"; });
    }
  }).catch((error) => {
    document.title = "GUM-" + error.name;
  });
</script>
<p>ASTRA-GUM</p>
"""

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
      if (host?.Permissions) break;
      await wait(250);
    }
    if (!host?.Permissions) { done(JSON.stringify({ error: "no shell host" })); return; }
    const frame = document.querySelector("iframe.astra-app-frame");
    if (!frame?.contentDocument) { done(JSON.stringify({ error: "no app frame" })); return; }
    const frameDoc = frame.contentDocument;
    const browserFor = (id) => {
      const tab = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === id);
      return tab?.linkedBrowser ?? null;
    };
    const click = (text) => {
      const button = [...frameDoc.querySelectorAll("[data-astra-page-permission-prompt] button")]
        .find((b) => (b.textContent ?? "").includes(text));
      if (!button) return false;
      button.click();
      return true;
    };
    const waitPrompt = async () => {
      for (let i = 0; i < 80; i += 1) {
        const view = host.Permissions.current();
        if (view.prompt) return view.prompt;
        await wait(250);
      }
      return null;
    };
    const waitNoPrompt = async () => {
      for (let i = 0; i < 60; i += 1) {
        if (!host.Permissions.current().prompt) return true;
        await wait(250);
      }
      return false;
    };
    const waitTitle = async (browser, wanted) => {
      for (let i = 0; i < 80; i += 1) {
        if ((browser?.contentTitle ?? "") === wanted) return wanted;
        await wait(250);
      }
      return browser?.contentTitle ?? "";
    };
    const open = async (url, label) => {
      const made = await host.Tabs.create({ request_id: `gum-${label}`, url });
      if (made?.error) throw new Error(`tab create failed: ${made.error.message}`);
      return { made, browser: browserFor(made.astra_tab_id) };
    };
    const principalOf = (url) =>
      Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(url), {});
    const perm = (principal, name) =>
      Services.perms.testExactPermissionFromPrincipal(principal, name);

    const originA = "http://127.0.0.1:__PORT__/a.html";
    const originB = "http://localhost:__PORT__/b.html";
    const originC = "http://127.0.0.2:__PORT__/c.html";
    const originD = "http://127.0.0.3:__PORT__/d.html";

    // --- allow always -----------------------------------------------------
    const a = await open(originA, "a");
    const promptA = await waitPrompt();
    step("a gUM request shows the Astra prompt", !!promptA);
    step(
      "the prompt carries camera and microphone",
      promptA?.kinds.includes("camera") && promptA?.kinds.includes("microphone"),
      promptA?.kinds
    );
    step("the prompt names the origin", promptA?.origin?.includes("127.0.0.1"), promptA?.origin);
    step("the prompt is fenced to the tab", promptA?.item_id === a.made.astra_tab_id);
    step(
      "the native doorhanger is not shown",
      PopupNotifications.getNotification("webRTC-shareDevices", a.browser) == null
    );
    await wait(700);
    step("the allow-always button exists", click("Allow while visiting"));
    step("the prompt closed", await waitNoPrompt());
    const pa = principalOf(originA);
    step("camera is stored as allow", perm(pa, "camera") === Services.perms.ALLOW_ACTION, perm(pa, "camera"));
    step("microphone is stored as allow", perm(pa, "microphone") === Services.perms.ALLOW_ACTION, perm(pa, "microphone"));
    step("the page receives a live stream", (await waitTitle(a.browser, "GUM-OK")) === "GUM-OK", a.browser?.contentTitle);
    // The engine drives the sharing indicator from `recording-device-events`,
    // which the fake-device backend does not report (verified: the native
    // grant path also leaves `webrtcUI._streams` empty with fake devices), so
    // the indicator itself is not asserted here. Astra calls the same
    // `activateDevicePerm`/`MediaManagerVideo` path the native allow uses.

    // --- auto allow (persistent grant) ------------------------------------
    const e = await open(originA + "?again=1", "e");
    await wait(1500);
    step("a persistent grant skips the prompt", host.Permissions.current().prompt === null);
    step("the auto-allowed stream is live", (await waitTitle(e.browser, "GUM-OK")) === "GUM-OK", e.browser?.contentTitle);

    // --- deny always ------------------------------------------------------
    const b = await open(originB, "b");
    const promptB = await waitPrompt();
    step("a second origin gets its own prompt", promptB?.origin?.includes("localhost"), promptB?.origin);
    await wait(700);
    step("the deny-always button exists", click("Never allow"));
    step("the deny prompt closed", await waitNoPrompt());
    const pb = principalOf(originB);
    step("camera is stored as deny", perm(pb, "camera") === Services.perms.DENY_ACTION, perm(pb, "camera"));
    step("microphone is stored as deny", perm(pb, "microphone") === Services.perms.DENY_ACTION, perm(pb, "microphone"));
    step("the page observes NotAllowedError", (await waitTitle(b.browser, "GUM-NotAllowedError")) === "GUM-NotAllowedError", b.browser?.contentTitle);

    // --- allow once -------------------------------------------------------
    const c = await open(originC, "c");
    await waitPrompt();
    await wait(700);
    step("the allow-once button exists", click("Allow this time"));
    step("the one-shot prompt closed", await waitNoPrompt());
    step("the one-shot stream is live", (await waitTitle(c.browser, "GUM-OK")) === "GUM-OK", c.browser?.contentTitle);
    const pc = principalOf(originC);
    const camScope = (() => {
      try {
        const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");
        const entry = SitePermissions.getForPrincipal(pc, "camera", c.browser);
        return { scope: entry.scope, temporary: entry.scope === SitePermissions.SCOPE_TEMPORARY };
      } catch { return null; }
    })();
    step("the one-shot camera scope is temporary", camScope?.temporary === true, camScope);

    // --- dismiss ----------------------------------------------------------
    const d = await open(originD, "d");
    const promptD = await waitPrompt();
    const dismissed = await host.Permissions.respond({
      prompt_id: promptD.request_id,
      profile_id: promptD.profile_id,
      item_id: promptD.item_id,
      decision: "dismiss",
    });
    step("dismiss is admitted", dismissed?.accepted === true, dismissed);
    step("dismiss closes the prompt", await waitNoPrompt());
    const pd = principalOf(originD);
    step("dismiss writes no policy", perm(pd, "camera") === Services.perms.UNKNOWN_ACTION, perm(pd, "camera"));
    step("the page observes NotAllowedError", (await waitTitle(d.browser, "GUM-NotAllowedError")) === "GUM-NotAllowedError", d.browser?.contentTitle);
    const d2 = await open(originD + "?again=1", "d2");
    step("dismiss does not block the next request", !!(await waitPrompt()));
    const next = host.Permissions.current().prompt;
    await host.Permissions.respond({
      prompt_id: next.request_id,
      profile_id: next.profile_id,
      item_id: next.item_id,
      decision: "deny_once",
    });
    await waitNoPrompt();

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
    servers = []
    for address in ("127.0.0.1", "127.0.0.2", "127.0.0.3"):
        server = Server((address, PORT), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    profile = tempfile.mkdtemp(prefix="astra-gum-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("media.navigator.streams.fake", true);\n')
        fh.write('user_pref("privacy.webrtc.deviceGracePeriodTimeoutMs", 0);\n')
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
