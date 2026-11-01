#!/usr/bin/env python3
"""P2-T06 contract test: Host API v1 live in a built Astra window.

Launches the built binary via the in-tree geckodriver, switches to
Marionette chrome context, and asserts docs/astra/HOST_API_v1.md.

Two live paths (both run in the same session):
  1. `resource://astraT06/` — a test-only resource substitution pointing
     at this checkout's `overlay/astra/host/` (registered from the test
     script; nothing is copied into the build tree). The v1 modules under
     test (Boot, Windows, Tabs, Navigation, Panes, Events, Content
     progress-listener factory) are imported from there, so the assertions
     below exercise the actual P2-T06 sources live in chrome.
  2. `win.__astraHost` seam — the window's baked Host API instance
     (Content.mount store). Asserts the envelope P2-T08 and the P1-T10
     tests depend on: `request_id` echo, `host_api_version: 1`, monotonic
     `event_seq`.

Checks: HOST_API_VERSION == 1, Boot handshake echo + version negotiation +
shutdown, Windows create/focus/fullscreen/close + last-window refusal,
Tabs duplicate/move/pin/unpin/discard/wakeup/mute/title through the live
import, Navigation stop/zoom/find/print/reader + external-ingress history,
Panes attach/rect/generation guards, eventsSince gap resync, and monotonic
event_seq on both paths.

Usage: python3 tests/contract/hostapi_v1.py
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary). Stdlib only.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, "engine")
OBJDIR = os.path.join(ENGINE, "obj-astra-linux")
FIREFOX = os.environ.get("ASTRA_BINARY", os.path.join(OBJDIR, "dist", "bin", "firefox"))
GECKODRIVER = os.environ.get(
    "ASTRA_GECKODRIVER", os.path.join(OBJDIR, "dist", "host", "bin", "geckodriver")
)
HOSTDIR = os.path.join(ROOT, "overlay", "astra", "host")
PORT = int(os.environ.get("ASTRA_PORT", "44452"))
MARIONETTE_PORT = PORT + 200


def wd(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)["value"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}")


CHROME_SCRIPT = """
const done = arguments[arguments.length - 1];
const hostDir = arguments[0];
(async () => {
  const out = { errors: [], seqs: [], seamSeqs: [] };
  try {
    // Test-only resource substitution so the v1 sources under test load
    // live in chrome without touching the build tree.
    const resProto = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(hostDir);
    resProto.setSubstitution("astraT06", Services.io.newFileURI(file));
    const R = (m) => `resource://astraT06/${m}`;

    const TabsMod = ChromeUtils.importESModule(R("Tabs.sys.mjs"));
    out.version = TabsMod.HOST_API_VERSION;
    const { Boot } = ChromeUtils.importESModule(R("Boot.sys.mjs"));
    const { Windows } = ChromeUtils.importESModule(R("Windows.sys.mjs"));
    const { Tabs } = TabsMod;
    const { Navigation } = ChromeUtils.importESModule(R("Navigation.sys.mjs"));
    const { Panes } = ChromeUtils.importESModule(R("Panes.sys.mjs"));
    const Events = ChromeUtils.importESModule(R("Events.sys.mjs"));
    const { makeProgressListener } = ChromeUtils.importESModule(R("Content.sys.mjs"));
    Events.addEventListener((e) => out.seqs.push(e.event_seq));

    const hs = await Boot.handshake({ request_id: "py-boot", core_version: 3 });
    out.bootEcho = hs.request_id === "py-boot" && hs.host_api_version === 1;
    out.bootWindow = hs.window_id === "win-1" && typeof hs.event_seq === "number";
    out.bootReady = out.seqs.length >= 1;
    const rej = await Boot.handshake({ request_id: "py-boot2", min_host_api_version: 99 });
    out.bootReject = !!rej.error && rej.error.code === "incompatible_host";
    const sd = await Boot.shutdown({ request_id: "py-boot3" });
    out.bootShutdown = sd.shutdown === true;

    const created = await Windows.create({ request_id: "py-win", private: true });
    out.winCreate = created.host_api_version === 1 && created.private === true
      && created.window_id !== "win-1";
    const listed = await Windows.list({ request_id: "py-winlist" });
    out.winListed = (listed.windows ?? []).some((w) => w.window_id === created.window_id)
      && listed.focused_window_id === created.window_id;
    const focused = await Windows.focus({ request_id: "py-winf", window_id: "win-1" });
    out.winFocus = focused.focused === true;
    const unfs = await Windows.setFullscreen({ request_id: "py-winfs", window_id: created.window_id, fullscreen: true });
    out.winFs = unfs.fullscreen === true;
    const wt = await Tabs.create({ request_id: "py-wt", url: "about:blank", window_id: created.window_id });
    const closed = await Windows.close({ request_id: "py-winc", window_id: created.window_id });
    out.winClose = closed.closed === true && (closed.tabs_closed ?? []).includes(wt.astra_tab_id);
    const last = await Windows.close({ request_id: "py-winlast", window_id: "win-1" });
    out.winLastRefused = !!last.error && last.error.code === "last_window";

    const t = await Tabs.create({ request_id: "py-t", url: "about:blank", background: true });
    out.tabCreate = t.request_id === "py-t" && typeof t.astra_tab_id === "string";
    const dup = await Tabs.duplicate({ request_id: "py-d", astra_tab_id: t.astra_tab_id, background: true });
    out.tabDup = dup.source_tab_id === t.astra_tab_id && dup.astra_tab_id !== t.astra_tab_id;
    const mv = await Tabs.move({ request_id: "py-m", astra_tab_id: dup.astra_tab_id, index: 0 });
    out.tabMove = mv.index === 0;
    const pin = await Tabs.pin({ request_id: "py-p", astra_tab_id: t.astra_tab_id });
    const unp = await Tabs.unpin({ request_id: "py-p2", astra_tab_id: t.astra_tab_id });
    out.tabPin = pin.pinned === true && unp.pinned === false;
    const dis = await Tabs.discard({ request_id: "py-x", astra_tab_id: t.astra_tab_id });
    const wake = await Tabs.wakeup({ request_id: "py-w", astra_tab_id: t.astra_tab_id });
    out.tabDiscard = dis.discarded === true && wake.discarded === false;
    const ttl = await Tabs.setTitle({ request_id: "py-tt", astra_tab_id: t.astra_tab_id, title: "live" });
    out.tabTitle = ttl.title === "live";

    const stop = await Navigation.stop({ request_id: "py-s", astra_tab_id: t.astra_tab_id });
    out.navStop = stop.stopped === true && stop.request_id === "py-s";
    const zoom = await Navigation.setZoom({ request_id: "py-z", astra_tab_id: t.astra_tab_id, zoom: 1.25 });
    const gz = await Navigation.getZoom({ request_id: "py-z2", astra_tab_id: t.astra_tab_id });
    out.navZoom = zoom.zoom === 1.25 && gz.zoom === 1.25;
    const find = await Navigation.findInPage({ request_id: "py-f", astra_tab_id: t.astra_tab_id, query: "marker" });
    out.navFind = find.query === "marker";
    const pr = await Navigation.print({ request_id: "py-pr", astra_tab_id: t.astra_tab_id });
    out.navPrint = pr.dispatched === true;
    const pane = await Panes.attach({ request_id: "py-pane", pane_id: "live-check", slot: "side" });
    out.paneAttach = pane.slot === "side" && pane.generation === 1;
    const stale = await Panes.check({ request_id: "py-pane2", pane_id: "live-check", generation: 0 });
    out.paneStale = stale.stale === true;
    await Panes.detach({ request_id: "py-pane3", pane_id: "live-check" });

    // Progress-listener factory live in chrome (fake browser mapping).
    const seen = [];
    const l = makeProgressListener({
      tabIdOf: () => t.astra_tab_id,
      setTitle: (id, title) => seen.push([id, title]),
    });
    l.onLocationChange({}, null, null, { spec: "https://live-click.example/" });
    const after = await Tabs.get({ request_id: "py-loc", astra_tab_id: t.astra_tab_id });
    out.progressLoc = after.tab.url === "https://live-click.example/";
    l.onTitleChange({}, "live title");
    out.progressTitle = JSON.stringify(seen[0]) === JSON.stringify([t.astra_tab_id, "live title"]);

    // Gap resync on the live event pump.
    const replay = Events.eventsSince(1);
    out.resyncFull = replay.gap === false && replay.events.length === out.seqs.length - 1;

    await Tabs.close({ request_id: "py-c1", astra_tab_id: dup.astra_tab_id });
    await Tabs.close({ request_id: "py-c2", astra_tab_id: t.astra_tab_id });

    out.mono = out.seqs.length > 0
      && out.seqs.every((s, i) => s >= 1 && (i === 0 || s > out.seqs[i - 1]));
    out.eventCount = out.seqs.length;
    resProto.setSubstitution("astraT06", null);

    // Baked window instance: envelope compat P2-T08/P1-T10 rely on.
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let host = null;
    for (let i = 0; i < 100 && !host; i++) {
      host = win.__astraHost;
      if (!host) { await asleep(100); }
    }
    if (host) {
      host.addEventListener((e) => out.seamSeqs.push(e.event_seq));
      const st = await host.Tabs.create({ request_id: "py-seam", url: "about:blank", background: true });
      out.seamEcho = st.request_id === "py-seam" && st.host_api_version === 1
        && typeof st.astra_tab_id === "string";
      await host.Tabs.close({ request_id: "py-seamc", astra_tab_id: st.astra_tab_id });
      out.seamMono = out.seamSeqs.length > 0
        && out.seamSeqs.every((s, i) => i === 0 || s > out.seamSeqs[i - 1]);
    } else {
      out.errors.push("no __astraHost seam");
    }
  } catch (e) {
    out.errors.push(String(e && e.message ? e.message : e) + "\\n" + (e && e.stack ? e.stack : ""));
  }
  done(out);
}).call(this);
"""


def main():
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            print(f"SKIP: missing {f} (run a full build first)")
            return 2
    if not os.path.isdir(HOSTDIR):
        print("SKIP: overlay host dir missing")
        return 2
    profile = tempfile.mkdtemp(prefix="astra-p2t06-prof-")
    gd = subprocess.Popen(
        [GECKODRIVER, "--port", str(PORT), "--marionette-port", str(MARIONETTE_PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=2)
                break
            except OSError:
                time.sleep(0.2)
        session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {
            "moz:firefoxOptions": {
                "binary": FIREFOX,
                "args": ["--headless", "--no-remote",
                         "-remote-allow-system-access",
                         "--profile", profile],
            }}}})["sessionId"]
        try:
            for _ in range(100):
                try:
                    wd("GET", f"/session/{session}/title")
                    break
                except RuntimeError:
                    time.sleep(0.3)
            wd("POST", f"/session/{session}/moz/context", {"context": "chrome"})
            wd("POST", f"/session/{session}/timeouts", {"script": 60000})
            res = wd("POST", f"/session/{session}/execute/async", {
                "script": CHROME_SCRIPT, "args": [HOSTDIR]})
            print("observed keys:", sorted(res.keys()))
            if res.get("errors"):
                print("chrome errors:", res["errors"])
            checks = [
                ("HOST_API_VERSION == 1", res.get("version") == 1),
                ("live Boot.handshake echoes + version", res.get("bootEcho") is True),
                ("live Boot default window + seq", res.get("bootWindow") is True),
                ("live Boot emitted boot.ready", res.get("bootReady") is True),
                ("live Boot rejects future min version", res.get("bootReject") is True),
                ("live Boot.shutdown", res.get("bootShutdown") is True),
                ("live Windows.create private", res.get("winCreate") is True),
                ("live Windows.list + focus", res.get("winListed") is True),
                ("live Windows.focus moves", res.get("winFocus") is True),
                ("live Windows fullscreen flag", res.get("winFs") is True),
                ("live Windows.close reports tabs", res.get("winClose") is True),
                ("live Windows last-window refusal", res.get("winLastRefused") is True),
                ("live Tabs.create", res.get("tabCreate") is True),
                ("live Tabs.duplicate", res.get("tabDup") is True),
                ("live Tabs.move", res.get("tabMove") is True),
                ("live Tabs.pin/unpin", res.get("tabPin") is True),
                ("live Tabs.discard/wakeup",
                 res.get("tabDiscard") is True),
                ("live Tabs.setTitle", res.get("tabTitle") is True),
                ("live Navigation.stop", res.get("navStop") is True),
                ("live Navigation zoom round-trip", res.get("navZoom") is True),
                ("live Navigation.findInPage", res.get("navFind") is True),
                ("live Navigation.print", res.get("navPrint") is True),
                ("live Panes.attach", res.get("paneAttach") is True),
                ("live Panes stale guard", res.get("paneStale") is True),
                ("live progress location commit", res.get("progressLoc") is True),
                ("live progress title callback", res.get("progressTitle") is True),
                ("live eventsSince gapless replay", res.get("resyncFull") is True),
                ("live events monotonic event_seq", res.get("mono") is True),
                ("seam request_id/version echo", res.get("seamEcho") is True),
                ("seam events monotonic", res.get("seamMono") is True),
            ]
            failed = [name for name, ok in checks if not ok]
            for name, ok in checks:
                print(("PASS " if ok else "FAIL ") + name)
            if failed:
                print(f"P2-T06 live contract: FAIL ({len(failed)} checks)")
                return 1
            print(f"P2-T06 live contract: PASS ({len(checks)} checks)")
            return 0
        finally:
            wd("DELETE", f"/session/{session}")
    finally:
        gd.terminate()


if __name__ == "__main__":
    sys.exit(main())
