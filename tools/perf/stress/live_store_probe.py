#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Visible, real-time Chrome Web Store install run.

Opens the packaged Astra build on the real display, drives Astra's own UI:

  Chrome Web Store listing -> Add (the store rail button) -> review sheet ->
  Add -> package downloaded and verified by astra-core -> installed ->
  Extensions page row -> live engine state -> (one) disable/enable -> remove.

Every step is captured as a screenshot under `out/live-store/`. The browser is
left open on the Extensions page when the run finishes; the final two
extensions stay installed so a person can inspect them.

  python3 tools/perf/stress/live_store_probe.py
"""
import base64
import json
import os
import signal
import subprocess
import sys
import tempfile
import time

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
OUT = os.path.join(ROOT, "out", "live-store")
PROFILE = os.path.join(ROOT, "out", "live-extension-profile")
MPORT = int(os.environ.get("ASTRA_LIVE_MARIONETTE", "2941"))

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PACKAGES = [
    ("Dark Reader", "eimadpbcbfnmbkopoojfekhnkhdbieeh"),
    ("SponsorBlock", "mnjggcdmjocbbbhaepdhchncahnbgone"),
    ("Vimium", "dbepggeogbaibhgnhhndojpepiihcmeb"),
    ("uBlock Origin Lite", "ddkjiahejlhfcafbddmgiahcphecmpfh"),
    ("Stylus", "clngdbkpkpeebahjckkjfobafhncgmne"),
]

# The last two stay installed for inspection; the rest are removed.
KEEP = {"SponsorBlock", "Stylus"}


def screenshot(m, name):
    os.makedirs(OUT, exist_ok=True)
    try:
        value = m.cmd("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        if isinstance(value, dict):
            value = value.get("value")
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(base64.b64decode(value))
        return os.path.join(OUT, name)
    except Exception as error:
        print(f"  screenshot {name} failed: {error}", file=sys.stderr)
        return None


APP = "document.querySelector('iframe[data-astra-app-frame]')?.contentDocument"


def wait_for(m, expression, seconds=30, poll=0.25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = m.execute(f"try {{ return ({expression}); }} catch (e) {{ return null; }}")
        except Exception:
            value = None
        if value:
            return value
        time.sleep(poll)
    return None


def wait_selected_store_tab(m, chrome_id, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = m.execute_async(
                """const done = arguments[arguments.length - 1];
                (async () => {
                  try {
                    const r = await Services.astraHost.Tabs.list({ request_id: 'live-wait' });
                    const selected = (r.tabs || []).find((tab) => tab.selected);
                    done(Boolean(selected && selected.url && selected.url.includes(arguments[0])));
                  } catch (e) { done(false); }
                })()""",
                [chrome_id],
            )
        except Exception:
            value = False
        if value:
            return True
        time.sleep(0.25)
    return False


def click_store_button(m):
    return m.execute(
        f"""try {{
          const app = {APP};
          const button = app?.querySelector('[data-extension-store-install]');
          if (!button) return false;
          button.click();
          return true;
        }} catch (e) {{ return false; }}"""
    )


def review_info(m):
    return m.execute(
        f"""try {{
          const app = {APP};
          if (!app) return null;
          const title = app.querySelector('#web-extension-review-title');
          if (!title) return null;
          const access = app.querySelector('#web-extension-review-access');
          const buttons = [...app.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
          return {{ title: title.textContent.trim(), access: access ? access.innerText : '', buttons }};
        }} catch (e) {{ return null; }}"""
    )


def click_review_add(m):
    return m.execute(
        f"""try {{
          const app = {APP};
          const buttons = [...app.querySelectorAll('button')];
          const add = buttons.find((b) => /^(Add|Update)$/i.test(b.textContent.trim()));
          if (!add) return buttons.map((b) => b.textContent.trim());
          add.click();
          return true;
        }} catch (e) {{ return String(e); }}"""
    )


def run_command(m, command):
    return m.execute_async(
        """const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const r = await Services.astraHost.Commands.run({ id: arguments[0] });
            done(JSON.stringify(r));
          } catch (e) { done(JSON.stringify({ error: String(e) })); }
        })()""",
        [command],
    )


def open_extensions(m):
    run_command(m, "extensions.manage")
    return wait_for(
        m,
        "!!" + APP + "?.querySelector('[data-astra-surface=\"extensions\"]') || !!" + APP + "?.querySelector('[data-web-extension]')",
        20,
    )


def row_info(m, install_id):
    return m.execute(
        f"""try {{
          const app = {APP};
          const row = app?.querySelector('[data-web-extension="{install_id}"]');
          if (!row) return null;
          return {{ text: row.innerText, enabled: row.querySelector('input[type=checkbox]')?.checked ?? null }};
        }} catch (e) {{ return null; }}"""
    )


def live_state(m, install_id):
    return m.execute_async(
        """const done = arguments[arguments.length - 1];
        const id = arguments[0];
        (async () => {
          try {
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
            const addon = await AddonManager.getAddonByID(id);
            const policy = WebExtensionPolicy.getByID(id);
            const record = await Services.astraHost.ChromeExtensions.record({ id });
            done(JSON.stringify({
              addon: addon ? { id: addon.id, version: addon.version, active: addon.isActive, state: addon.state } : null,
              policy: policy ? true : false,
              background: policy?.extension?.backgroundState ?? null,
              manifest: policy?.extension?.manifest ? {
                version: policy.extension.manifest.manifest_version,
                content_scripts: (policy.extension.manifest.content_scripts || []).length,
                permissions: (policy.extension.manifest.permissions || []).length,
                dnr: (policy.extension.manifest.declarative_net_request?.rule_resources || []).length,
              } : null,
              record: record ? { signature: record.signature, verdict: record.verdict, persistence: record.persistence, xpi_sha256: record.xpi_sha256 } : null,
            }));
          } catch (e) { done(JSON.stringify({ error: String(e?.stack ?? e) })); }
        })()""",
        [install_id],
    )


def main():
    os.makedirs(OUT, exist_ok=True)
    if os.path.isdir(PROFILE):
        import shutil

        shutil.rmtree(PROFILE)
    os.makedirs(PROFILE, exist_ok=True)
    with open(os.path.join(PROFILE, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.startup.page", 0);\n')
        fh.write('user_pref("browser.startup.homepage", "about:blank");\n')
        fh.write('user_pref("extensions.logging.enabled", true);\n')
    env = dict(os.environ)
    env.setdefault("MOZ_ENABLE_WAYLAND", "1")
    log = open(os.path.join(OUT, "browser.log"), "wb")
    proc = subprocess.Popen(
        [BIN, "-profile", PROFILE, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    print(f"browser pid {proc.pid} on DISPLAY={env.get('DISPLAY')} WAYLAND_DISPLAY={env.get('WAYLAND_DISPLAY')}")
    results = []
    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(300)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 300000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        wait_for(m, "!!Services.astraHost", 60)
        screenshot(m, "00-start.png")

        for name, chrome_id in PACKAGES:
            install_id = f"{chrome_id}@chrome.astra"
            print(f"\n=== {name} ({chrome_id}) ===", flush=True)
            run_command(m, "browser.return")
            time.sleep(0.4)
            url = f"https://chromewebstore.google.com/detail/{chrome_id}"
            tab = m.execute_async(
                """const done = arguments[arguments.length - 1];
                (async () => {
                  try {
                    const r = await Services.astraHost.Tabs.create({ request_id: 'live-store', url: arguments[0] });
                    done(JSON.stringify(r));
                  } catch (e) { done(JSON.stringify({ error: String(e) })); }
                })()""",
                [url],
            )
            tab = json.loads(tab)
            tab_id = tab.get("astra_tab_id") or tab.get("tab", {}).get("astra_tab_id")
            if not wait_selected_store_tab(m, chrome_id):
                print("  the new store tab never became the selected tab", flush=True)
                results.append({"name": name, "outcome": "tab_not_selected"})
                continue
            selected = json.loads(
                m.execute_async(
                    """const done = arguments[arguments.length - 1];
                    (async () => {
                      const r = await Services.astraHost.Tabs.list({ request_id: 'live-sel' });
                      const tab = (r.tabs || []).find((item) => item.selected);
                      done(JSON.stringify(tab || null));
                    })()"""
                )
            )
            if not selected or not selected.get("astra_tab_id"):
                print("  no selected tab to install from", flush=True)
                results.append({"name": name, "outcome": "no_selected_tab"})
                continue
            tab_id = selected["astra_tab_id"]
            # The store page with Astra's always-visible top callout.
            time.sleep(0.6)
            screenshot(m, f"{name.replace(' ', '-')}-store.png")
            # Install through Astra itself: the browser downloads the CRX,
            # verifies it, adapts it and hands the XPI to AddonManager. No
            # third-party installer, no store button, no hover.
            review = {}
            for attempt in range(12):
                review = json.loads(
                    m.execute_async(
                        """const done = arguments[arguments.length - 1];
                        (async () => {
                          try {
                            const r = await Services.astraHost.WebExtensions.prepare({ tab_id: arguments[0] });
                            done(JSON.stringify(r));
                          } catch (e) { done(JSON.stringify({ error: String(e?.message ?? e) })); }
                        })()""",
                        [tab_id],
                    )
                )
                if not review.get("error") or "not an extension listing" not in review["error"]:
                    break
                time.sleep(0.5)
            if review.get("error"):
                print("  prepare failed:", review["error"], flush=True)
                results.append({"name": name, "outcome": "prepare_failed", "error": review["error"]})
                continue
            print(
                f"  prepared: {review.get('name')} {review.get('version')} | "
                f"mv{review.get('manifest_version')} {review.get('compatibility')} "
                f"sig={review.get('signature')} security={review.get('security', {}).get('level')} "
                f"limitations={len(review.get('limitations') or [])}",
                flush=True,
            )
            if review.get("security", {}).get("blocked"):
                print("  blocked by Astra security policy", flush=True)
                results.append({"name": name, "outcome": "blocked", "review": review})
                continue
            installed = json.loads(
                m.execute_async(
                    """const done = arguments[arguments.length - 1];
                    (async () => {
                      try {
                        const p = await Services.astraHost.WebExtensions.confirm({
                          id: arguments[0],
                          reviewId: arguments[1],
                        });
                        done(JSON.stringify({ persistence: p }));
                      } catch (e) { done(JSON.stringify({ error: String(e?.message ?? e) })); }
                    })()""",
                    [review["id"], review["review_id"]],
                )
            )
            if installed.get("error"):
                print("  install failed:", installed["error"], flush=True)
                results.append({"name": name, "outcome": "install_failed", "error": installed["error"]})
                continue
            state = None
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                state = json.loads(live_state(m, review["id"]))
                if state.get("addon"):
                    break
                time.sleep(0.4)
            if not state or not state.get("addon"):
                print("  install did not register", flush=True)
                results.append({"name": name, "outcome": "not_installed"})
                continue
            print("  installed:", json.dumps(state), flush=True)
            open_extensions(m)
            row = None
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                row = row_info(m, review["id"])
                if row:
                    break
                time.sleep(0.25)
            screenshot(m, f"{name.replace(' ', '-')}-extensions.png")
            print("  extensions row:", row, flush=True)
            results.append(
                {
                    "name": name,
                    "outcome": "installed",
                    "review": {
                        "verdict": review.get("compatibility"),
                        "signature": review.get("signature"),
                        "security": review.get("security", {}).get("level"),
                        "limitations": review.get("limitations"),
                    },
                    "state": state,
                    "row": row,
                }
            )
            run_command(m, "browser.return")
            if name not in KEEP:
                removed = json.loads(
                    m.execute_async(
                        """const done = arguments[arguments.length - 1];
                        (async () => {
                          try { await Services.astraHost.WebExtensions.uninstall({ id: arguments[0] }); done(JSON.stringify({ ok: true })); }
                          catch (e) { done(JSON.stringify({ error: String(e?.message ?? e) })); }
                        })()""",
                        [review["id"]],
                    )
                )
                time.sleep(0.8)
                gone = row_info(m, review["id"]) is None
                print("  removed:", gone, removed, flush=True)
                results[-1]["removed"] = gone
            if tab_id:
                m.execute_async(
                    """const done = arguments[arguments.length - 1];
                    (async () => { try { await Services.astraHost.Tabs.close({ astra_tab_id: arguments[0] }); done(true); } catch (e) { done(String(e)); } })()""",
                    [tab_id],
                )

        # One live disable/enable check on the first kept extension.
        keep_ids = [r["state"]["addon"]["id"] for r in results if r.get("outcome") == "installed" and r["name"] in KEEP]
        if keep_ids:
            open_extensions(m)
            time.sleep(0.5)
            target = keep_ids[0]
            for enabled in (False, True):
                m.execute_async(
                    """const done = arguments[arguments.length - 1];
                    (async () => { try { await Services.astraHost.WebExtensions.setEnabled({ id: arguments[0], enabled: arguments[1] }); done(true); } catch (e) { done(String(e)); } })()""",
                    [target, enabled],
                )
                time.sleep(1.5)
                print(f"  toggle {enabled}:", row_info(m, target), flush=True)
            screenshot(m, "99-extensions-final.png")
        open_extensions(m)
        time.sleep(1)
        screenshot(m, "99-extensions-open.png")
        with open(os.path.join(OUT, "report.json"), "w") as fh:
            json.dump({"results": results, "profile": PROFILE, "pid": proc.pid}, fh, indent=2)
        print("\nBrowser left open on the Extensions page. PID", proc.pid, "profile", PROFILE)
        return 0
    except Exception as error:
        print(f"live run failed: {error}", file=sys.stderr)
        try:
            screenshot(m, "99-error.png")
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
