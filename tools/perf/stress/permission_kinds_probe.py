#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P6b-3 probe: the non-media permission kinds render Astra's own prompt.

The `Integration.contentPermission` seam now routes every yes/no engine prompt
to the app. This probe drives the two that a page can raise on its own:

  * `desktop-notification` -> `Notification.requestPermission()`
  * `persistent-storage`   -> `navigator.storage.persist()`

For each request it asserts the Astra prompt (not Firefox's doorhanger), the
exact kind, the tab fence, the policy written to `Services.perms`, the page's
own observation, and that dismiss writes nothing.

Picker-shaped prompts (`serial` port list, `midi`/site-permission add-on
install, WebRTC screen/audio capture) intentionally keep the engine UI and are
asserted absent from the routed kinds.
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
PORT = int(os.environ.get("ASTRA_KINDS_PORT", "2881"))
MPORT = int(os.environ.get("ASTRA_KINDS_MARIONETTE", "2882"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

NOTIFY = """<!doctype html>
<meta charset="utf-8">
<title>ASTRA-NOTIF-pending</title>
<script>
  window.__astraNotif = "pending";
  Notification.requestPermission().then((state) => {
    window.__astraNotif = state;
    document.title = "ASTRA-NOTIF-" + state;
  }).catch((error) => {
    window.__astraNotif = "error:" + error.name;
    document.title = "ASTRA-NOTIF-error";
  });
</script>
<p>ASTRA-NOTIF</p>
"""

PERSIST = """<!doctype html>
<meta charset="utf-8">
<title>ASTRA-PERSIST-pending</title>
<script>
  window.__astraPersist = "pending";
  navigator.storage.persist().then((granted) => {
    window.__astraPersist = granted === true ? "granted" : "denied";
    document.title = "ASTRA-PERSIST-" + window.__astraPersist;
  }).catch((error) => {
    window.__astraPersist = "error:" + error.name;
    document.title = "ASTRA-PERSIST-error";
  });
</script>
<p>ASTRA-PERSIST</p>
"""

FAIL = '<!doctype html><meta charset="utf-8"><title>ASTRA-PLAIN</title><p>plain</p>'


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        if self.path.startswith("/notify"):
            body = NOTIFY
        elif self.path.startswith("/persist"):
            body = PERSIST
        else:
            body = FAIL
        payload = body.encode()
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
    const click = (text) => {
      const button = [...frameDoc.querySelectorAll("[data-astra-page-permission-prompt] button")]
        .find((b) => (b.textContent ?? "").includes(text));
      if (!button) return false;
      button.click();
      return true;
    };
    const open = async (url, label) => {
      const made = await host.Tabs.create({ request_id: `kind-${label}`, url });
      if (made?.error) throw new Error(`tab create failed: ${made.error.message}`);
      return { made, browser: browserFor(made.astra_tab_id) };
    };
    const principalOf = (url) =>
      Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(url), {});
    const perm = (principal, name) =>
      Services.perms.testExactPermissionFromPrincipal(principal, name);

    // --- notifications, allow always --------------------------------------
    const originA = "http://127.0.0.1:__PORT__/notify";
    const a = await open(originA, "a");
    const promptA = await waitPrompt();
    step("a notification request shows the Astra prompt", !!promptA);
    step("the prompt is the notification kind", promptA?.kinds.length === 1 && promptA?.kinds[0] === "notifications", promptA?.kinds);
    step("the prompt names the origin", promptA?.origin?.includes("127.0.0.1"), promptA?.origin);
    step("the prompt is fenced to the tab", promptA?.item_id === a.made.astra_tab_id);
    step(
      "the native notification doorhanger is not shown",
      PopupNotifications.getNotification("web-notifications", a.browser) == null
    );
    step(
      "the app rendered the Astra card",
      !!frameDoc.querySelector("[data-astra-page-permission-prompt]")
    );
    await wait(700);
    step("the allow-always button exists", click("Allow while visiting"));
    step("the prompt closed", await waitNoPrompt());
    const pa = principalOf(originA);
    step("notification is stored as allow", perm(pa, "desktop-notification") === Services.perms.ALLOW_ACTION, perm(pa, "desktop-notification"));
    step("the page observes granted", (await waitTitle(a.browser, "ASTRA-NOTIF-granted")) === "ASTRA-NOTIF-granted", a.browser?.contentTitle);

    // --- notifications, deny always ---------------------------------------
    const originB = "http://localhost:__PORT__/notify";
    const b = await open(originB, "b");
    const promptB = await waitPrompt();
    step("a second origin gets its own prompt", promptB?.origin?.includes("localhost"), promptB?.origin);
    await wait(700);
    step("the deny-always button exists", click("Never allow"));
    step("the deny prompt closed", await waitNoPrompt());
    const pb = principalOf(originB);
    step("notification is stored as deny", perm(pb, "desktop-notification") === Services.perms.DENY_ACTION, perm(pb, "desktop-notification"));
    step("the page observes denied", (await waitTitle(b.browser, "ASTRA-NOTIF-denied")) === "ASTRA-NOTIF-denied", b.browser?.contentTitle);

    // --- persistent storage, allow always ---------------------------------
    const originC = "http://127.0.0.2:__PORT__/persist";
    const c = await open(originC, "c");
    const promptC = await waitPrompt();
    step("a storage request shows the Astra prompt", !!promptC);
    step("the prompt is the persistent-storage kind", promptC?.kinds.length === 1 && promptC?.kinds[0] === "persistent-storage", promptC?.kinds);
    step(
      "the native persistent-storage panel is not shown",
      PopupNotifications.getNotification("persistent-storage", c.browser) == null
    );
    await wait(700);
    step("the storage allow button exists", click("Allow while visiting"));
    step("the storage prompt closed", await waitNoPrompt());
    const pc = principalOf(originC);
    step("persistent-storage is stored as allow", perm(pc, "persistent-storage") === Services.perms.ALLOW_ACTION, perm(pc, "persistent-storage"));
    step("the page observes granted", (await waitTitle(c.browser, "ASTRA-PERSIST-granted")) === "ASTRA-PERSIST-granted", c.browser?.contentTitle);

    // --- persistent storage, dismiss --------------------------------------
    const originD = "http://127.0.0.3:__PORT__/persist";
    const d = await open(originD, "d");
    const promptD = await waitPrompt();
    step("a fresh origin prompts again", !!promptD);
    const dismissed = await host.Permissions.respond({
      prompt_id: promptD.request_id,
      profile_id: promptD.profile_id,
      item_id: promptD.item_id,
      decision: "dismiss",
    });
    step("dismiss is admitted", dismissed?.accepted === true, dismissed);
    step("dismiss closes the prompt", await waitNoPrompt());
    const pd = principalOf(originD);
    step("dismiss writes no policy", perm(pd, "persistent-storage") === Services.perms.UNKNOWN_ACTION, perm(pd, "persistent-storage"));
    step("the page observes denied", (await waitTitle(d.browser, "ASTRA-PERSIST-denied")) === "ASTRA-PERSIST-denied", d.browser?.contentTitle);

    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


def main():
    servers = []
    for address in ("127.0.0.1", "127.0.0.2", "127.0.0.3"):
        server = Server((address, PORT), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    profile = tempfile.mkdtemp(prefix="astra-kinds-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("dom.webnotifications.requireuserinteraction", false);\n')
        fh.write('user_pref("permissions.desktop-notification.postPrompt.enabled", false);\n')
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
