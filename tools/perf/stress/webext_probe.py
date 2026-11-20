#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P9 probe: the extension manager lists and controls a real add-on.

Builds an unsigned probe XPI, installs it through AddonManager (the profile
allows unsigned installs), then exercises the host module: list, disable,
enable, open options, uninstall. Each step reads the real engine state.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
MPORT = int(os.environ.get("ASTRA_WEBEXT_MARIONETTE", "2909"))
ADDON_ID = "probe@astra.test"
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

MANIFEST = json.dumps(
    {
        "manifest_version": 2,
        "name": "Astra Probe Extension",
        "version": "1.0.0",
        "description": "A probe",
        "browser_specific_settings": {"gecko": {"id": ADDON_ID}},
        "options_ui": {"page": "options.html"},
        "permissions": ["https://example.com/*"],
    },
    indent=2,
)
OPTIONS = "<!doctype html><title>Probe options</title><p>options</p>"

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
      if (host?.WebExtensions && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.WebExtensions) { done(JSON.stringify({ error: "no WebExtensions host" })); return; }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    await AddonManager.readyPromise;

    // A release-mode build (`--enable-release`) ignores
    // `xpinstall.signatures.required` and refuses an unsigned XPI with
    // ERROR_SIGNEDSTATE_REQUIRED. That is the build's posture, not a defect in
    // the install flow; say SKIP instead of reporting a product failure.
    try {
      const probeFile = new FileUtils.File("__XPI__");
      const probeInstall = await AddonManager.getInstallForFile(probeFile, null);
      if (probeInstall && probeInstall.error === AddonManager.ERROR_SIGNEDSTATE_REQUIRED) {
        done(JSON.stringify({ skip: "unsigned XPI refused by a release-mode build (signatures required)" }));
        return;
      }
    } catch (e) {
      // Fall through: a file that cannot be read at all is a real failure.
    }

    let review = null;
    try {
      review = await host.WebExtensions.prepareFile({ path: "__XPI__" });
    } catch (e) {
      out.installError = String(e);
    }
    step("prepareFile reviews the package", review?.from_file === true && review?.name === "Astra Probe Extension", review);
    if (review) {
      try {
        await host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id });
      } catch (e) {
        out.installError = String(e);
      }
    }
    let addon = null;
    for (let i = 0; i < 80; i += 1) {
      addon = await AddonManager.getAddonByID("__ID__");
      if (addon) break;
      await wait(250);
    }
    if (!addon) {
      done(JSON.stringify({ ...out, error: out.installError ?? "install did not register" }));
      return;
    }
    step("the probe extension installed", addon.id === "__ID__", addon.id);

    let list = await host.WebExtensions.list();
    const found = list.find((entry) => entry.id === "__ID__");
    step("the manager lists it", !!found, list.map((entry) => entry.id));
    step("the manager reports it running", found?.enabled === true && found?.state === "running", found);
    step("the manager reports its site access", found?.site_scoped === true);
    step("the manager reports its options page", found?.has_options === true);

    await host.WebExtensions.setEnabled({ id: "__ID__", enabled: false });
    let off = null;
    for (let i = 0; i < 40; i += 1) {
      off = (await host.WebExtensions.list()).find((entry) => entry.id === "__ID__");
      if (off?.enabled === false) break;
      await wait(250);
    }
    step("disable reaches the engine", off?.enabled === false && off?.state === "off", off);

    await host.WebExtensions.setEnabled({ id: "__ID__", enabled: true });
    let on = null;
    for (let i = 0; i < 40; i += 1) {
      on = (await host.WebExtensions.list()).find((entry) => entry.id === "__ID__");
      if (on?.enabled === true) break;
      await wait(250);
    }
    step("enable reaches the engine", on?.enabled === true && on?.state === "running", on);

    await host.WebExtensions.openOptions({ id: "__ID__" });
    let options = null;
    for (let i = 0; i < 40; i += 1) {
      for (const tab of gBrowser.tabs) {
        const spec = (() => { try { return tab.linkedBrowser?.currentURI?.spec ?? ""; } catch { return ""; } })();
        if (spec.startsWith("moz-extension://") && spec.endsWith("/options.html")) { options = spec; break; }
      }
      if (options) break;
      await wait(250);
    }
    step("options open a tab", !!options, options);

    await host.WebExtensions.uninstall({ id: "__ID__" });
    let gone = null;
    for (let i = 0; i < 60; i += 1) {
      gone = (await host.WebExtensions.list()).find((entry) => entry.id === "__ID__");
      if (!gone) break;
      await wait(250);
    }
    step("uninstall removes it", !gone);
    step("the engine no longer knows it", (await AddonManager.getAddonByID("__ID__")) === null);

    const cancelled = await host.WebExtensions.prepareFile({ path: "__XPI__" });
    await host.WebExtensions.cancel({ reviewId: cancelled.review_id });
    step("a cancelled review installs nothing", (await AddonManager.getAddonByID("__ID__")) === null);
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


def build_xpi(directory):
    path = os.path.join(directory, "probe.xpi")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", MANIFEST)
        archive.writestr("options.html", OPTIONS)
    return path


def main():
    profile = tempfile.mkdtemp(prefix="astra-webext-")
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
        time.sleep(4)
        # The path goes into a JS string literal: on Windows a raw backslash
        # path is an escape sequence (`\U` → `U`), so the probe used to open a
        # path that does not exist and then blame the install flow.
        script = RUN.replace('"__XPI__"', json.dumps(xpi)).replace("__ID__", ADDON_ID)
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
        if out.get("steps") and all(s["ok"] for s in out["steps"]):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    if out.get("skip"):
        print(f"SKIP {out['skip']}", file=sys.stderr)
        return 2
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
