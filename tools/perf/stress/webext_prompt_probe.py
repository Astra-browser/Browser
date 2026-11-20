#!/usr/bin/env python3
import functools, http.server, json, os, shutil, signal, subprocess, sys, tempfile, threading, time, zipfile

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = os.path.join(ENGINE, "dist", "bin", "firefox")
MPORT = 2912
ADDON_ID = "prompt-probe@astra.test"
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L

MANIFEST = json.dumps({
    "manifest_version": 2,
    "name": "Astra Prompt Probe",
    "version": "1.0.0",
    "browser_specific_settings": {"gecko": {"id": ADDON_ID}},
    "permissions": ["https://example.com/*", "notifications"]
}, indent=2)

RUN = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 80; i += 1) {
      host = Services.astraHost;
      if (host?.WebExtensions && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.WebExtensions) { done(JSON.stringify({ error: "no WebExtensions host" })); return; }
    step("the shell hooked the prompt", window.PopupNotifications.__astraExtensionPromptHooked === true);

    let prompt = null;
    const off = host.addEventListener((event) => {
      if (event.type === "web-extension-prompt-changed" && event.data?.prompt) prompt = event.data.prompt;
    });

    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    await AddonManager.readyPromise;
    const install = await AddonManager.getInstallForURL("http://127.0.0.1:__PORT__/prompt.xpi", {
      browser: gBrowser.selectedBrowser,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    const installPromise = new Promise((resolve, reject) => {
      install.addListener({
        onInstallEnded: (_install, addon) => resolve(addon),
        onInstallFailed: () => reject(new Error("install failed")),
        onInstallCancelled: () => reject(new Error("install cancelled")),
      });
      AddonManager.installAddonFromAOM(gBrowser.selectedBrowser, Services.io.newURI("http://127.0.0.1:__PORT__/prompt.xpi"), install);
    });
    for (let i = 0; i < 80 && !prompt; i += 1) await wait(100);
    step("the engine prompt reaches Astra", prompt?.name === "Astra Prompt Probe", prompt);
    step("its permission list survives", Array.isArray(prompt?.messages) && prompt.messages.length > 0, prompt?.messages);
    step("the native doorhanger is absent", !window.PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser));

    await wait(500);
    const app = document.querySelector("[data-astra-app-frame]")?.contentDocument;
    const sheet = app?.querySelector('[role="alertdialog"]');
    const sheetText = sheet?.textContent ?? "";
    step("Astra renders the install sheet", !!sheet && sheetText.includes("Astra Prompt Probe"), sheetText.slice(0, 220));
    step("the sheet lists the permissions", sheetText.includes("Access your data for sites in example.com domains") && sheetText.includes("Display notifications to you"));
    step("the sheet offers the private-window choice", !!sheet?.querySelector('[role="checkbox"], input[type="checkbox"]'));
    const add = [...(sheet?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Add");
    step("the sheet has Astra's Add control", !!add);
    if (add) {
      add.click();
      await wait(300);
    } else if (prompt) {
      await host.WebExtensions.answerPrompt({ prompt_id: prompt.prompt_id, accept: true, private_windows: false, technical_data: true });
    }
    await installPromise;
    const addon = await AddonManager.getAddonByID("__ID__");
    step("accept installs through the engine", !!addon && addon.isActive === true, addon?.id ?? null);
    off();
    await host.WebExtensions.uninstall({ id: "__ID__" });
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.stack ?? error) }));
  }
})()
"""

def build_xpi(directory):
    path = os.path.join(directory, "prompt.xpi")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", MANIFEST)
    return path

def main():
    profile = tempfile.mkdtemp(prefix="astra-prompt-")
    xpi = build_xpi(profile)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=profile)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("xpinstall.signatures.required", false);\n')
        fh.write('user_pref("extensions.autoDisableScopes", 0);\n')
        fh.write('user_pref("extensions.enabledScopes", 15);\n')
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
        out = json.loads(m.execute_async(RUN.replace("__XPI__", xpi).replace("__ID__", ADDON_ID).replace("__PORT__", str(port))))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except Exception:
            try: proc.kill()
            except Exception: pass
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
