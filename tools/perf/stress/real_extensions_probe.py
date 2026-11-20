#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Real Firefox and Chrome extensions through Astra's own intake.

Network-dependent and opt-in:

  ASTRA_REAL_EXTENSIONS=1 tools/perf/hidden-display.sh \
    python3 tools/perf/stress/real_extensions_probe.py out/real-extensions

Packages are acquired from their official distribution path:
  - Chrome Web Store CRX via Chrome's update service (9 MB cap);
  - addons.mozilla.org's signed XPI.

For each package the probe checks the real engine, not only the manifest:
CRX3 signature, adapted manifest, AddonManager activation, background state,
registered content scripts, declared permissions, DNR rulesets, then
uninstall and engine state again. A static-only run is a SKIP (exit 2).
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
MPORT = int(os.environ.get("ASTRA_REAL_EXT_MARIONETTE", "2919"))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "out", "real-extensions")
CACHE = os.path.join(OUT, "packages")

if os.environ.get("ASTRA_REAL_EXTENSIONS") != "1":
    print("SKIP: set ASTRA_REAL_EXTENSIONS=1 to acquire and run real extensions", file=sys.stderr)
    sys.exit(2)
if not os.path.isfile(BIN):
    print(f"SKIP: no built browser at {BIN}", file=sys.stderr)
    sys.exit(2)

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

# A representative set: a content blocker with DNR, a theming/content-script
# extension, a userscript manager, a style manager, and a signed AMO XPI.
CHROME = [
    ("uBlock Origin Lite", "ddkjiahejlhfcafbddmgiahcphecmpfh", "content blocker (MV3 + DNR)"),
    ("Dark Reader", "eimadpbcbfnmbkopoojfekhnkhdbieeh", "theming + content scripts (MV3)"),
    ("Tampermonkey", "dhdgffkkebhmkfjojejmpbldmpobfkfo", "userscript manager (MV3, dynamic injection)"),
    ("Stylus", "clngdbkpkpeebahjckkjfobafhncgmne", "style manager (MV3)"),
]
FIREFOX = [
    ("uBlock Origin", "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi"),
]


def fetch(url, path, limit=96 * 1024 * 1024):
    if os.path.isfile(path) and os.path.getsize(path) > 1024:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Astra extension compatibility test"})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError("package larger than the intake limit")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def crx_url(chrome_id):
    return (
        "https://clients2.google.com/service/update2/crx?response=redirect"
        "&prodversion=131.0&acceptformat=crx2,crx3"
        f"&x=id%3D{chrome_id}%26uc"
    )


RUN = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { extensions: [], metrics: {} };
  const step = (name, ok, detail) => out.entries.push({ name, ok: ok === true, detail: detail ?? null });
  out.entries = [];
  try {
    let host = null;
    for (let i = 0; i < 160; i += 1) {
      host = Services.astraHost;
      if (host?.WebExtensions && host?.ChromeExtensions) break;
      await wait(250);
    }
    if (!host?.WebExtensions) { done(JSON.stringify({ ...out, error: "no Host API" })); return; }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    const io = globalThis.IOUtils ?? ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;

    const packages = __PACKAGES__;
    for (const item of packages) {
      const row = { name: item.name, source: item.source, class: item.class };
      const entries = [];
      const check = (name, ok, detail) => entries.push({ name, ok: ok === true, detail: detail ?? null });
      try {
        const start = performance.now();
        const review = await host.WebExtensions.prepareFile({ path: item.path });
        row.inspect_ms = Math.round((performance.now() - start) * 10) / 10;
        row.verdict = review.compatibility;
        row.security = review.security?.level ?? "none";
        row.signature = review.signature;
        row.limitations = review.limitations.length;
        check("the package is inspected", review.id.length > 0, review.id);
        if (item.source === "chrome") {
          check("the CRX3 signature verified", review.signature === "verified", review.signature);
        } else {
          check("the signed XPI is accepted", review.id.length > 0, review.signature);
        }
        check("the package is not blocked", review.security?.blocked !== true, review.security);
        const install = performance.now();
        await host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id });
        row.install_ms = Math.round((performance.now() - install) * 10) / 10;
        const id = review.id;
        let addon = null;
        for (let i = 0; i < 160; i += 1) {
          addon = await AddonManager.getAddonByID(id);
          if (addon) break;
          await wait(250);
        }
        check("the engine registered it", addon !== null, id);
        check("the engine reports it active", addon?.isActive === true, addon?.state);
        row.version = addon?.version ?? null;
        const policy = WebExtensionPolicy.getByID(id);
        check("the webextension policy exists", policy !== null, id);
        const manifest = policy?.extension?.manifest ?? null;
        row.background_kind = manifest?.background ? (manifest.background.service_worker ? "service_worker" : "scripts") : "none";
        row.content_scripts = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts.length : 0;
        row.permissions = Array.isArray(manifest?.permissions) ? manifest.permissions.length : 0;
        check("the engine sees a background environment", row.background_kind !== "none", row.background_kind);
        if (review.manifest_version === 3) {
          check("the MV3 worker was adapted to a document", !manifest?.background?.service_worker, row.background_kind);
        }
        if (item.class.includes("content scripts")) {
          check("content scripts are registered", row.content_scripts > 0, row.content_scripts);
        }
        if (item.class.includes("userscript manager")) {
          const perms = manifest?.permissions ?? [];
          check(
            "the userscript API permission survives",
            perms.includes("userScripts") || perms.includes("scripting"),
            perms,
          );
        }
        if (item.class.includes("DNR")) {
          const rules = manifest?.declarative_net_request?.rule_resources ?? [];
          check("the DNR rulesets survive adaptation", rules.length > 0, rules.length);
        }
        // Wake the event page with a page load, then read its real state.
        if (host.Tabs) {
          try {
            await host.Tabs.create({ request_id: "real-ext-page", url: "about:blank" });
            await wait(700);
          } catch {
            // about:blank may be refused by the tab model; state is still read.
          }
        }
        let state = policy?.extension?.backgroundState ?? null;
        for (let i = 0; i < 40 && state === null; i += 1) {
          await wait(250);
          state = WebExtensionPolicy.getByID(id)?.extension?.backgroundState ?? null;
        }
        row.background_state = state;
        check("the background environment has a state", state !== null, state);
        row.entries = entries;
        // Remove and prove the engine forgot it.
        await host.WebExtensions.uninstall({ id });
        let gone = null;
        for (let i = 0; i < 120; i += 1) {
          gone = await AddonManager.getAddonByID(id);
          if (!gone) break;
          await wait(250);
        }
        check("uninstall removes it", gone === null);
        check("the policy is gone", WebExtensionPolicy.getByID(id) === null);
        row.removed = gone === null;
      } catch (error) {
        row.error = String(error?.stack ?? error);
        row.entries = entries;
      }
      out.extensions.push(row);
    }
    const total = out.extensions.reduce((sum, row) => sum + (row.entries?.length ?? 0), 0);
    const failed = out.extensions.flatMap((row) => (row.entries ?? []).filter((entry) => !entry.ok).map((entry) => `${row.name}: ${entry.name}`));
    out.summary = { packages: out.extensions.length, checks: total, failed };
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.stack ?? error) }));
  }
})()
"""


def main():
    os.makedirs(CACHE, exist_ok=True)
    packages = []
    for name, chrome_id, kind in CHROME:
        path = fetch(crx_url(chrome_id), os.path.join(CACHE, f"{chrome_id}.crx"))
        packages.append({"name": name, "source": "chrome", "class": kind, "path": path})
    for name, url in FIREFOX:
        path = fetch(url, os.path.join(CACHE, f"{name.replace(' ', '-').lower()}.xpi"))
        packages.append({"name": name, "source": "firefox", "class": "signed AMO XPI", "path": path})

    profile = tempfile.mkdtemp(prefix="astra-real-ext-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.startup.page", 0);\n')
        fh.write('user_pref("browser.startup.homepage", "about:blank");\n')
    log = open(os.path.join(profile, "browser.log"), "wb")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    result = {}
    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(300)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 300000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        script = RUN.replace("__PACKAGES__", json.dumps(packages))
        result = json.loads(m.execute_async(script))
    finally:
        try:
            result.setdefault("packages", packages)
            with open(os.path.join(OUT, "result.json"), "w") as fh:
                json.dump(result, fh, indent=2)
            if not result.get("summary") or result.get("error"):
                try:
                    shutil.copy(os.path.join(profile, "browser.log"), os.path.join(OUT, "browser.log"))
                except Exception:
                    pass
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=20)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            log.close()
            if result.get("summary") and not result["summary"]["failed"]:
                shutil.rmtree(profile, ignore_errors=True)
            else:
                print(f"profile kept: {profile}", file=sys.stderr)
        except Exception:
            pass
    summary = result.get("summary") or {"packages": 0, "checks": 0, "failed": ["probe did not run"]}
    print(json.dumps({"summary": summary, "extensions": [
        {k: v for k, v in row.items() if k != "entries"} for row in result.get("extensions", [])
    ]}, indent=2))
    return 0 if summary["checks"] > 0 and not summary["failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
