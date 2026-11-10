#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P5b probe: Astra organisation survives a restart through the Rust store.

Phase A launches the dev build with `astra.core.command` pointing at the real
`astra-core` binary, creates a "Work" space with a pinned tab, saves, and
checks the SQLite row. A private window is opened and asked to save; it must
refuse and leave no private URL in the database.

Phase B relaunches the same profile: the saved spaces come back and the pinned
tab is moved into Work again.
"""
import http.server
import json
import os
import shutil
import signal
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
CORE = os.environ.get("ASTRA_CORE", os.path.join(ROOT, "target", "debug", "astra-core"))
MPORT = int(os.environ.get("ASTRA_METADATA_MARIONETTE", "2882"))
PORT = int(os.environ.get("ASTRA_METADATA_PORT", "2881"))
WORK = f"http://127.0.0.1:{PORT}/work.html"
PRIVATE = f"http://127.0.0.1:{PORT}/private.html"

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

A = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 120; i += 1) {
      host = Services.astraHost;
      if (host?.Metadata && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.Metadata) { done(JSON.stringify({ error: "no shell host" })); return; }
    for (let i = 0; i < 60; i += 1) {
      if (host.Metadata.status().available) break;
      await wait(250);
    }
    step("the sidecar is available", host.Metadata.status().available === true, host.Metadata.status());
    step("the org starts empty", host.Metadata.status().restored !== true);

    const madeSpace = await host.Tabs.createSpace({ request_id: "m-space", name: "Work" });
    const activeSpace = host.__spacesState().active_space_id;
    step("the Work space exists", madeSpace?.accepted === true, madeSpace);
    step("the Work space is active", host.__spacesState().spaces.length === 2, host.__spacesState());
    const madeTab = await host.Tabs.create({ request_id: "m-tab", url: "__WORK__" });
    step("the tab was created", typeof madeTab?.astra_tab_id === "string", madeTab);
    // SessionStore persists the committed document, not the requested URL, so
    // wait for the local page to actually commit before saving.
    let committed = false;
    for (let i = 0; i < 80; i += 1) {
      const native = [...gBrowser.tabs].find(
        (t) => t.getAttribute("astra-tab-id") === madeTab.astra_tab_id
      );
      if (native?.linkedBrowser?.currentURI?.spec === "__WORK__") { committed = true; break; }
      await wait(250);
    }
    step("the work page committed", committed, [...gBrowser.tabs].map((t) => t.getAttribute("astra-tab-id")));
    await host.Tabs.pin({ request_id: "m-pin", astra_tab_id: madeTab.astra_tab_id });
    const tabs = (await host.Tabs.list({ request_id: "m-list" })).tabs ?? [];
    const mine = tabs.find((t) => t.astra_tab_id === madeTab.astra_tab_id);
    step("the tab is in Work", mine?.space_id === activeSpace, [mine?.space_id, activeSpace]);
    step("the tab is pinned", mine?.pinned === true);

    const saved = await host.Metadata.save();
    step("the organisation saved", saved.saved === true, saved);
    step("the save counted the tab", saved.tabs >= 1, saved.tabs);

    // A private window must never write. Its own shell replaces
    // Services.astraHost when it mounts.
    const before = host.Metadata.status();
    const madeWindow = await host.Windows.create({ request_id: "m-private", private: true });
    step("a private window opened", madeWindow?.private === true, madeWindow);
    let priv = null;
    for (let i = 0; i < 80; i += 1) {
      priv = Services.astraHost;
      if (priv?.Metadata && priv !== host) break;
      await wait(250);
    }
    if (priv && priv !== host) {
      const privateTab = await priv.Tabs.create({ request_id: "m-priv-tab", url: "__PRIVATE__" });
      await wait(500);
      const privSave = await priv.Metadata.save({ private: true });
      step("the private window refuses to save", privSave.saved === false && privSave.reason === "private", privSave);
      step(
        "the private window did not flip the process store",
        priv.Metadata.status().private === false
          && priv.Metadata.status().available === true,
        priv.Metadata.status()
      );
      out.privateTab = privateTab?.astra_tab_id ?? null;
    } else {
      step("the private window refused to save", false, "no private host");
    }
    out.before = before;
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""

B = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 120; i += 1) {
      host = Services.astraHost;
      if (host?.Metadata && host?.Tabs && host.Metadata.status().available) break;
      await wait(250);
    }
    if (!host?.Metadata) { done(JSON.stringify({ error: "no shell host" })); return; }
    step("the sidecar is available again", host.Metadata.status().available === true, host.Metadata.status());
    const raw = await host.Boot.coreCall({ request_id: "m2-raw", name: "session.load", payload: { name: "organisation" } });
    let rawTabs = null;
    try { rawTabs = JSON.parse(raw.payload?.snapshot ?? "{}").tabs?.length ?? null; } catch {}
    step("the store still has the saved tab", rawTabs === 1, rawTabs);
    const spaceState = host.__spacesState();
    step(
      "the Work space came back at startup",
      spaceState.spaces.some((space) => space.name === "Work"),
      spaceState.spaces.map((space) => space.name)
    );

    // The startup restore above already ran. Reload the snapshot and apply it
    // to a tab at the saved URL so this phase proves the whole path
    // (store -> host -> model) without depending on SessionStore's lazy
    // restore, which `sessionstore_probe.py` covers separately.
    const prepared = await host.Metadata.prepare({ private: false });
    step("the snapshot reloads", prepared.state === "loaded", prepared);
    const made = await host.Tabs.create({ request_id: "m2-tab", url: "__WORK__" });
    step("a tab at the saved URL exists", typeof made?.astra_tab_id === "string", made);
    const restored = await host.Metadata.restore({ private: false });
    step("the saved organisation applies", restored.restored === true, restored);
    const tabs = (await host.Tabs.list({ request_id: "m2-list" })).tabs ?? [];
    const work = tabs.find((t) => t.astra_tab_id === made.astra_tab_id);
    step("the tab is in Work", work?.space_id === "space-2", work?.space_id);
    step("the tab is pinned", work?.pinned === true, work?.pinned);
    const saved = await host.Metadata.save();
    step("the re-applied organisation saves", saved.saved === true, saved);
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        body = f"<!doctype html><title>{self.path}</title><p>{self.path}</p>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def launch(profile):
    log = open(os.path.join(profile, "browser.log"), "ab")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log


def marionette():
    m = L.Marionette(MPORT, timeout=120)
    m.sock.settimeout(240)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("WebDriver:SetTimeouts", {"script": 180000, "implicit": 0, "pageLoad": 120000})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(4)
    return m


def stop(proc, log):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=15)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    log.close()


def main():
    httpd = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="astra-metadata-")
    db = os.path.join(profile, "astra", "core.sqlite")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        if os.environ.get("ASTRA_METADATA_AUTODETECT") != "1":
            fh.write(f'user_pref("astra.core.command", "{CORE}");\n')
    out = {"phase_a": {}, "phase_b": {}, "db": {}}
    try:
        proc, log = launch(profile)
        m = None
        try:
            m = marionette()
            out["phase_a"] = json.loads(
                m.execute_async(A.replace("__WORK__", WORK).replace("__PRIVATE__", PRIVATE))
            )
        finally:
            # A clean application quit is what writes SessionStore and runs the
            # shell's final Metadata.save(); SIGTERM alone is a crash path.
            try:
                if m is not None:
                    m.execute("try { Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return 'ok'; } catch (e) { return String(e); }")
            except Exception:
                pass
            try:
                proc.wait(timeout=30)
            except Exception:
                pass
            stop(proc, log)

        if os.path.exists(db):
            conn = sqlite3.connect(db)
            try:
                row = conn.execute(
                    "SELECT name, snapshot FROM sessions ORDER BY updated_at DESC LIMIT 1"
                ).fetchone()
            finally:
                conn.close()
            if row:
                snap = json.loads(row[1])
                out["db"] = {
                    "name": row[0],
                    "spaces": [s["name"] for s in snap.get("spaces", [])],
                    "urls": [t["url"] for t in snap.get("tabs", [])],
                    "pinned": [t["pinned"] for t in snap.get("tabs", [])],
                    "private_absent": all("/private.html" not in t["url"] for t in snap.get("tabs", [])),
                }
        else:
            out["db"] = {"error": "no database"}

        proc, log = launch(profile)
        m = None
        try:
            m = marionette()
            out["phase_b"] = json.loads(m.execute_async(B.replace("__WORK__", WORK)))
        finally:
            try:
                if m is not None:
                    m.execute("try { Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return 'ok'; } catch (e) { return String(e); }")
            except Exception:
                pass
            try:
                proc.wait(timeout=30)
            except Exception:
                pass
            stop(proc, log)
    finally:
        httpd.shutdown()
        ok = (
            out["phase_a"].get("steps")
            and all(s["ok"] for s in out["phase_a"]["steps"])
            and out["phase_b"].get("steps")
            and all(s["ok"] for s in out["phase_b"]["steps"])
            and out["db"].get("private_absent") is True
        )
        if ok:
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
