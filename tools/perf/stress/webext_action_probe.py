#!/usr/bin/env python3
import json, os, shutil, signal, subprocess, sys, tempfile, time, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.path.join(ROOT, "engine", "obj-astra-linux")
BIN = os.path.join(ENGINE, "dist", "bin", "firefox")
MPORT = 2911
ADDON_ID = "action-probe@astra.test"
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L

MANIFEST = json.dumps({
    "manifest_version": 2,
    "name": "Astra Action Probe",
    "version": "1.0.0",
    "browser_specific_settings": {"gecko": {"id": ADDON_ID}},
    "browser_action": {"default_title": "Action Probe", "default_popup": "popup.html"},
    "permissions": ["https://example.com/*"]
}, indent=2)
POPUP = "<!doctype html><title>Action popup</title><p id='probe'>action popup</p>"

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
    await AddonManager.readyPromise;

    const seen = [];
    const off = host.addEventListener((event) => {
      if (event.type === "extension-actions-changed") seen.push(event.data);
    });

    const review = await host.WebExtensions.prepareFile({ path: "__XPI__" });
    step("prepareFile reviews the action package", review?.name === "Astra Action Probe", review);
    await host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id });

    let addon = null;
    for (let i = 0; i < 80; i += 1) {
      addon = await AddonManager.getAddonByID("__ID__");
      if (addon) break;
      await wait(250);
    }
    step("the action package installed", !!addon);
    await wait(400);
    await host.WebExtensions.list();
    await wait(200);
    const projection = seen.filter((entry) => entry.profile_id !== "").at(-1);
    const action = projection?.actions?.find((entry) => entry.runtime.install_id === "__ID__");
    let diag = null;
    try {
      const current = await AddonManager.getAddonByID("__ID__");
      const policy = WebExtensionPolicy.getByID("__ID__");
      const api = window.gUnifiedExtensions.browserActionFor(policy);
      diag = {
        active: current?.isActive,
        userDisabled: current?.userDisabled,
        appDisabled: current?.appDisabled,
        hidden: current?.hidden,
        hasAction: !!(policy?.manifest?.browser_action || policy?.manifest?.action),
        hasApi: !!api,
        hasActionObj: !!api?.action,
        shown: api?.action?.isShownForTab(gBrowser.selectedTab),
        tabId: gBrowser.selectedTab?.getAttribute("astra-tab-id"),
        manifest: policy?.manifest?.browser_action ?? null,
      };
    } catch (e) { diag = String(e); }
    step("the action is projected", !!action, { action: action ?? null, projection: projection ?? seen.at(-1) ?? null, diag });

    const result = await host.WebExtensions.invokeAction({
      profile_id: "default",
      install_id: "__ID__",
      runtime_generation: action?.runtime?.generation ?? "",
      action_revision: action?.revision ?? "",
      anchor_x: 420,
      anchor_y: 180,
      anchor_width: 28,
      anchor_height: 28,
    });
    step("invokeAction accepts the gesture", result?.accepted === true, result);
    await wait(700);

    const panel = document.querySelector('[data-astra-extension-popup="true"]');
    step("the Astra popup panel opened", !!panel && panel.state === "open", panel?.state ?? null);
    const popupBrowser = panel?.querySelector("browser");
    const spec = popupBrowser?.currentURI?.spec ?? "";
    step("the extension's own popup loaded", spec.includes("/popup.html"), spec);
    step("the native extensions panel stayed closed", !document.getElementById("unified-extensions-panel")?.open);
    if (panel) panel.hidePopup();
    await wait(300);
    step("the popup panel is released", !document.querySelector('[data-astra-extension-popup="true"]'));

    off();
    await host.WebExtensions.uninstall({ id: "__ID__" });
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.stack ?? error) }));
  }
})()
"""

def build_xpi(directory):
    path = os.path.join(directory, "action.xpi")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", MANIFEST)
        archive.writestr("popup.html", POPUP)
    return path

def main():
    profile = tempfile.mkdtemp(prefix="astra-action-")
    xpi = build_xpi(profile)
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
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
        script = RUN.replace("__XPI__", xpi).replace("__ID__", ADDON_ID)
        out = json.loads(m.execute_async(script))
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
