#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Broad live extension corpus: install each package, check it, remove it.

Reads a corpus produced from the Chrome Web Store update service (the same
packages a person gets from the store) and drives the packaged dev build:

  inspect -> install -> engine registration -> active -> background state ->
  content scripts / DNR / permissions -> uninstall -> gone

Each batch gets a fresh profile and a fresh browser, so one bad extension
cannot poison the next batch. A per-call timeout keeps a hanging install from
stopping the run; the package is recorded as failed and the batch continues.

  ASTRA_EXTENSION_CORPUS=1 tools/perf/hidden-display.sh \
    python3 tools/perf/stress/extension_corpus_probe.py out/extension-corpus

The corpus itself is built by `tools/perf/stress/extension_corpus_fetch.py`.
Exit 0 PASS, 1 FAIL, 2 SKIP without the opt-in / binary / corpus.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
MPORT = int(os.environ.get("ASTRA_CORPUS_MARIONETTE", "2923"))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "out", "extension-corpus")
CORPUS = os.path.join(OUT, "corpus.json")
PACKAGES = os.path.join(OUT, "packages")
BATCH_SIZE = int(os.environ.get("ASTRA_CORPUS_BATCH", "10"))

if os.environ.get("ASTRA_EXTENSION_CORPUS") != "1":
    print("SKIP: set ASTRA_EXTENSION_CORPUS=1 to run the broad corpus", file=sys.stderr)
    sys.exit(2)
if not os.path.isfile(BIN):
    print(f"SKIP: no built browser at {BIN}", file=sys.stderr)
    sys.exit(2)
if not os.path.isfile(CORPUS):
    print(f"SKIP: no corpus at {CORPUS}; run extension_corpus_fetch.py", file=sys.stderr)
    sys.exit(2)

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

RUN = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms)),
    ]);
  const out = { packages: [] };
  try {
    let host = null;
    for (let i = 0; i < 200; i += 1) {
      host = Services.astraHost;
      if (host?.WebExtensions && host?.ChromeExtensions) break;
      await wait(250);
    }
    if (!host?.WebExtensions) { done(JSON.stringify({ ...out, error: "no Host API" })); return; }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    const items = __PACKAGES__;
    for (const item of items) {
      const row = {
        name: item.name,
        id: item.id,
        category: item.category,
        era: item.era,
        steps: [],
      };
      const step = (name, ok, detail) => row.steps.push({ name, ok: ok === true, detail: detail ?? null });
      let installedId = null;
      try {
        const start = performance.now();
        const review = await withTimeout(host.WebExtensions.prepareFile({ path: item.path }), 45000, "inspect");
        row.inspect_ms = Math.round((performance.now() - start) * 10) / 10;
        row.manifest_version = review.manifest_version ?? null;
        row.verdict = review.compatibility ?? null;
        row.security = review.security?.level ?? null;
        row.blocked = review.security?.blocked === true;
        row.signature = review.signature ?? null;
        row.limitations = review.limitations?.length ?? 0;
        row.unsupported = review.warnings?.length ?? 0;
        row.package_name = review.name;
        row.version = review.version;
        step("inspected", true);
        if (row.blocked) {
          row.outcome = "blocked";
          step("security refused the package", true, review.security?.summary ?? null);
          out.packages.push(row);
          continue;
        }
        installedId = review.id;
        const installStart = performance.now();
        await withTimeout(
          host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id }),
          90000,
          "install",
        );
        row.install_ms = Math.round((performance.now() - installStart) * 10) / 10;
        let addon = null;
        for (let i = 0; i < 80; i += 1) {
          addon = await AddonManager.getAddonByID(review.id);
          if (addon) break;
          await wait(250);
        }
        row.registered = addon !== null;
        step("engine registered it", addon !== null, addon?.version ?? null);
        if (!addon) {
          row.outcome = "not_registered";
          out.packages.push(row);
          continue;
        }
        row.is_active = addon.isActive === true;
        row.user_disabled = addon.userDisabled === true;
        row.app_disabled = addon.appDisabled === true;
        step("active", addon.isActive === true, addon.state ?? null);
        step("not disabled by the engine", addon.appDisabled !== true, addon.appDisabled);
        const policy = WebExtensionPolicy.getByID(review.id);
        row.policy = policy !== null;
        step("webextension policy exists", policy !== null);
        const manifest = policy?.extension?.manifest ?? null;
        row.background_kind = manifest?.background
          ? manifest.background.service_worker
            ? "service_worker"
            : manifest.background.page
              ? "page"
              : "scripts"
          : "none";
        row.content_scripts = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts.length : 0;
        row.permissions = Array.isArray(manifest?.permissions) ? manifest.permissions.length : 0;
        row.dnr_rulesets = manifest?.declarative_net_request?.rule_resources?.length ?? 0;
        row.has_options = Boolean(manifest?.options_ui || manifest?.options_page);
        row.has_action = Boolean(manifest?.action || manifest?.browser_action);
        // Wake an event page the way a real page would, then read the state.
        try {
          await withTimeout(
            host.Tabs.create({ request_id: "corpus-wake", url: "about:blank" }),
            8000,
            "wake tab",
          );
        } catch {
          // The tab model may refuse about:blank; the state is still read.
        }
        let state = null;
        for (let i = 0; i < 16; i += 1) {
          state = WebExtensionPolicy.getByID(review.id)?.extension?.backgroundState ?? null;
          if (state !== null) break;
          await wait(250);
        }
        row.background_state = state;
        if (row.background_kind !== "none") {
          step("background has a state", state !== null, state);
        }
        row.outcome = "installed";
        step("installed and active", true);
      } catch (error) {
        row.error = String(error?.message ?? error);
        row.outcome = "error";
        step("package operation failed", false, row.error);
      }
      if (installedId !== null) {
        try {
          const removeStart = performance.now();
          await withTimeout(host.WebExtensions.uninstall({ id: installedId }), 45000, "uninstall");
          row.uninstall_ms = Math.round((performance.now() - removeStart) * 10) / 10;
          let gone = null;
          for (let i = 0; i < 40; i += 1) {
            gone = await AddonManager.getAddonByID(installedId);
            if (!gone) break;
            await wait(250);
          }
          row.removed = gone === null;
          step("uninstalled", gone === null);
        } catch (error) {
          row.removed = false;
          step("uninstalled", false, String(error?.message ?? error));
        }
      }
      out.packages.push(row);
    }
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.stack ?? error) }));
  }
})()
"""


def launch(profile):
    log = open(os.path.join(profile, "browser.log"), "ab")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log


def run_batch(batch):
    profile = tempfile.mkdtemp(prefix="astra-corpus-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.startup.page", 0);\n')
        fh.write('user_pref("browser.startup.homepage", "about:blank");\n')
    proc, log = launch(profile)
    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(600)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 900000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        payload = json.dumps(batch)
        return json.loads(m.execute_async(RUN.replace("__PACKAGES__", payload)))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=25)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
        try:
            log_path = os.path.join(profile, "browser.log")
            if os.path.isfile(log_path) and os.path.getsize(log_path) > 0:
                shutil.copy(log_path, os.path.join(OUT, "browser.log"))
        except Exception:
            pass
        shutil.rmtree(profile, ignore_errors=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    corpus = json.load(open(CORPUS))
    items = []
    for entry in corpus:
        path = os.path.join(PACKAGES, f"{entry['id']}.crx")
        if os.path.isfile(path) and os.path.getsize(path) > 1024:
            items.append({**entry, "path": path})
    results = []
    batches = [items[i : i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
    for index, batch in enumerate(batches, 1):
        print(f"batch {index}/{len(batches)}: {len(batch)} packages", file=sys.stderr, flush=True)
        try:
            result = run_batch(batch)
        except Exception as error:
            for item in batch:
                results.append(
                    {
                        "name": item["name"],
                        "id": item["id"],
                        "category": item["category"],
                        "era": item["era"],
                        "outcome": "batch_error",
                        "error": str(error),
                        "steps": [],
                    }
                )
            continue
        by_id = {row["id"]: row for row in result.get("packages", [])}
        for item in batch:
            row = by_id.get(item["id"])
            if row is None:
                row = {
                    "name": item["name"],
                    "id": item["id"],
                    "category": item["category"],
                    "era": item["era"],
                    "outcome": "missing",
                    "error": result.get("error", "the batch returned no row for this package"),
                    "steps": [],
                }
            results.append(row)
        # Keep the partial evidence if the browser died mid-batch.
        with open(os.path.join(OUT, "report.partial.json"), "w") as fh:
            json.dump({"packages": results}, fh, indent=2)

    def works(row):
        if row.get("outcome") != "installed":
            return False
        if row.get("registered") is not True or row.get("is_active") is not True:
            return False
        if row.get("background_kind") not in (None, "none") and row.get("background_state") is None:
            return False
        if row.get("removed") is not True:
            return False
        return True

    for row in results:
        row["works"] = works(row)
    summary = {
        "packages": len(results),
        "installed": sum(1 for r in results if r.get("outcome") == "installed"),
        "works": sum(1 for r in results if r.get("works")),
        "blocked": sum(1 for r in results if r.get("outcome") == "blocked"),
        "failed": [r["name"] for r in results if not r.get("works")],
    }
    report = {"summary": summary, "packages": results}
    with open(os.path.join(OUT, "report.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    markdown = [
        "# Real extension corpus",
        "",
        f"{summary['works']} / {summary['packages']} packages installed, ran and were removed.",
        "",
        "| Package | MV | Verdict | Security | Background | Content | Installed | Works |",
        "|---|---:|---|---|---|---:|---|---|",
    ]
    for row in sorted(results, key=lambda r: r.get("name", "")):
        bg = row.get("background_kind", "?")
        if row.get("background_state"):
            bg += f" ({row['background_state']})"
        markdown.append(
            f"| {row.get('name','?')} | {row.get('manifest_version','?')} | {row.get('verdict','?')} | "
            f"{row.get('security','?')} | {bg} | {row.get('content_scripts','?')} | "
            f"{row.get('outcome','?')} | {'yes' if row.get('works') else 'NO'} |"
        )
    with open(os.path.join(OUT, "report.md"), "w") as fh:
        fh.write("\n".join(markdown) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["packages"] > 0 and not summary["failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
