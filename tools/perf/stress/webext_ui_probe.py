#!/usr/bin/env python3
import json, os, shutil, signal, subprocess, sys, tempfile, time, zipfile

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = os.path.join(ENGINE, "dist", "bin", "firefox")
MPORT = 2913
ADDON_ID = "ui-probe@astra.test"
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L

MANIFEST = json.dumps({
    "manifest_version": 2,
    "name": "Astra UI Probe",
    "version": "1.0.0",
    "browser_specific_settings": {"gecko": {"id": ADDON_ID}},
    "browser_action": {"default_title": "UI Probe", "default_popup": "popup.html"},
    "options_ui": {"page": "options.html"},
    "permissions": ["https://example.com/*"]
}, indent=2)
POPUP = "<!doctype html><title>UI Probe popup</title><p>popup</p>"
OPTIONS = "<!doctype html><title>UI Probe options</title><p>options</p>"

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

    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    await AddonManager.readyPromise;
    const review = await host.WebExtensions.prepareFile({ path: "__XPI__" });
    await host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id });
    let addon = null;
    for (let i = 0; i < 80; i += 1) {
      addon = await AddonManager.getAddonByID("__ID__");
      if (addon) break;
      await wait(250);
    }
    step("probe extension installed", !!addon);

    const frame = document.querySelector("[data-astra-app-frame]");
    const app = frame?.contentDocument;
    step("the app frame is present", !!app);
    const buttons = [...(app?.querySelectorAll(".utility-bar button") ?? [])];
    const extensionsButton = buttons.find((button) => button.getAttribute("title") === "Extensions" || button.getAttribute("aria-label") === "Extensions");
    step("the sidebar exposes Extensions", !!extensionsButton, buttons.map((button) => button.getAttribute("title") ?? button.getAttribute("aria-label")));
    if (extensionsButton) {
      await host.WebExtensions.setPinned({ id: "__ID__", pinned: false });
      extensionsButton.click();
      await wait(300);
      const menu = app?.querySelector('.bar-popover[data-open="true"]');
      const menuText = menu?.textContent ?? "";
      step("the icon offers Chrome Web Store", menuText.includes("Chrome Web Store"), menuText);
      step("the icon offers Firefox Add-ons", menuText.includes("Firefox Add-ons"), menuText);
      const manage = [...(menu?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Manage extensions");
      step("the icon offers Manage extensions", !!manage);
      if (manage) manage.click();
      await wait(900);
    }
    const manager = app?.querySelector(".library-shell");
    step("the Extensions page is in front", !!manager);
    const text = manager?.textContent ?? "";
    step("the page offers Chrome Web Store", text.includes("Chrome Web Store"));
    step("the page offers Firefox Add-ons", text.includes("Firefox Add-ons"));
    const row = app?.querySelector('[data-web-extension="__ID__"]');
    step("the installed extension has a row", !!row);
    step("the row has its on/off control", !!row?.querySelector('input[type="checkbox"], [role="switch"]'));
    step("the row has a pin control", !!row?.querySelector('.pin-action'));
    const rowAction = row?.querySelector('.row-action:not(.pin-action)');
    step("the row has an open control", !!rowAction, rowAction?.getAttribute("data-row-action") ?? null);
    step("the action projection reached the app", rowAction?.getAttribute("data-row-action") === "extension", rowAction?.getAttribute("data-row-action") ?? null);
    let invokeResult = null;
    try {
      invokeResult = await app.defaultView.__astraInvoke("extension_action_invoke", {
        profileId: "default",
        installId: "__ID__",
        runtimeGeneration: "0000000000000001",
        actionRevision: "00000000000000000000000000000000",
        anchorX: 20,
        anchorY: 20,
        anchorWidth: 28,
        anchorHeight: 28,
      });
    } catch (error) { invokeResult = String(error); }
    step("the app can invoke the action directly", invokeResult?.accepted === true, invokeResult);
    await wait(700);
    let panel = document.querySelector('[data-astra-extension-popup="true"]');
    let spec = panel?.querySelector('browser')?.currentURI?.spec ?? "";
    step("the direct invoke opens the popup", !!panel && spec.includes("/popup.html"), { spec, state: panel?.state });
    panel?.hidePopup();
    await wait(250);

    const open = app?.querySelector('[data-web-extension="__ID__"] .row-action:not(.pin-action)');
    if (open) {
      open.click();
      await wait(150);
      let early = document.querySelector('[data-astra-extension-popup="true"]');
      await wait(650);
      panel = document.querySelector('[data-astra-extension-popup="true"]');
      spec = panel?.querySelector('browser')?.currentURI?.spec ?? "";
      step("the manager opens the extension's own UI", !!panel && spec.includes("/popup.html"), {
        spec,
        state: panel?.state ?? null,
        early: early?.state ?? null,
        relayError: window.__astraLastRelayError ?? null,
      });
      panel?.hidePopup();
      await wait(250);
    }
    const pin = app?.querySelector('[data-web-extension="__ID__"] .pin-action');
    if (pin) {
      pin.click();
      await wait(250);
      const pressed = app?.querySelector('[data-web-extension="__ID__"] .pin-action')?.getAttribute('aria-pressed');
      step("pin reaches the manager", pressed === "true", pressed);
      const pinned = app?.querySelector('[data-pinned-extension="__ID__"]');
      step("the pinned button is in the sidebar", !!pinned);
      if (pinned) {
        pinned.click();
        await wait(700);
        const pinnedPanel = document.querySelector('[data-astra-extension-popup="true"]');
        const pinnedSpec = pinnedPanel?.querySelector('browser')?.currentURI?.spec ?? "";
        step("the pinned button opens the extension", !!pinnedPanel && pinnedSpec.includes("/popup.html"), pinnedSpec);
        pinnedPanel?.hidePopup();
        await wait(250);
      }
    }
    await host.WebExtensions.uninstall({ id: "__ID__" });
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.stack ?? error) }));
  }
})()
"""

def build_xpi(directory):
    path = os.path.join(directory, "ui.xpi")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", MANIFEST)
        archive.writestr("popup.html", POPUP)
        archive.writestr("options.html", OPTIONS)
    return path

def main():
    profile = tempfile.mkdtemp(prefix="astra-ui-")
    xpi = build_xpi(profile)
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
        time.sleep(5)
        out = json.loads(m.execute_async(RUN.replace("__XPI__", xpi).replace("__ID__", ADDON_ID)))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except Exception:
            try: proc.kill()
            except Exception: pass
        log.close()
        if out.get("steps") and all(s["ok"] for s in out["steps"]):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1

if __name__ == "__main__":
    sys.exit(main())
