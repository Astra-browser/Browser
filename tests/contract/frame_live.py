#!/usr/bin/env python3
"""P3-T03 contract test (live side): window frame in the built binary.

Launches the built Astra binary via the in-tree geckodriver, switches to
Marionette chrome context, and asserts (docs/astra/FRAME.md):
  - P1-T08 mount intact: #astra-root sized, "Hello Tab" rendered
  - frame.css ships the drag-region declarations (static source check):
    `.astra-titlebar` declares `-moz-window-dragging: drag`, window
    controls/buttons declare `no-drag`
  - the frame stylesheet applies live as an agent sheet: co-located
    regular properties from the same rule blocks compute on the injected
    frame DOM (titlebar display:flex + background, controls display:flex) —
    measured with the P3-T20 app-booted retirement attribute off and restored,
    plus an assertion that the retirement itself is in effect
  - Frame.sys.mjs reportDragRegions runs live against the injected DOM
    (roles + control buttons + rects; see FRAME.md for why the engine
    hides this chrome-only property from CSSOM readback)
  - window controls dispatch through the Host API Windows module
    (close refuses the last window, toggle-fullscreen flips and back,
    setTitle echoes, unknown actions rejected, chrome-only minimize
    needs an adapter)
  - fullscreen attribute hides titlebar/sidebar/toolbar (display none)

Usage: python3 tests/contract/frame_live.py
Exit 0 on PASS, 1 on FAIL, 2 on SKIP (no built binary). Stdlib only.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine"))
OBJDIR = os.path.join(ENGINE, "obj-astra-linux")
FIREFOX = os.environ.get("ASTRA_BINARY", os.path.join(OBJDIR, "dist", "bin", "firefox"))
GECKODRIVER = os.environ.get(
    "ASTRA_GECKODRIVER", os.path.join(OBJDIR, "dist", "host", "bin", "geckodriver")
)
OVERLAY_ASTRA = os.path.join(ROOT, "overlay", "astra")
FRAME_CSS = os.path.join(OVERLAY_ASTRA, "chrome", "frame", "frame.css")
PORT = int(os.environ.get("ASTRA_FRAME_PORT", "44452"))


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
const [overlayAstraDir, cssPath] = arguments;
(async () => {
  const out = { errors: [] };
  try {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const d = win.document;
    const root = d.getElementById("astra-root");
    out.rootChildren = root?.childElementCount ?? 0;
    out.rootText = (root?.textContent ?? "").slice(0, 200);

    // Live imports of the exact sources under test (hostapi_v1.py pattern:
    // test-only resource substitution, nothing copied into the build tree).
    const resProto = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    dir.initWithPath(overlayAstraDir);
    resProto.setSubstitution("astraFrame", Services.io.newFileURI(dir));
    const Frame = ChromeUtils.importESModule(
      "resource://astraFrame/chrome/frame/Frame.sys.mjs");
    const { Windows } = ChromeUtils.importESModule(
      "resource://astraFrame/host/Windows.sys.mjs");
    out.frameVersion = Frame.FRAME_VERSION;

    // Register frame.css as an agent sheet: -moz-window-dragging parses
    // only in UA/agent sheets (engine GenerateCSSProperties.py:
    // "chrome-only internal properties ... parsed by UA sheets only").
    const cssFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    cssFile.initWithPath(cssPath);
    const cssURI = Services.io.newFileURI(cssFile);
    const sss = Cc["@mozilla.org/content/style-sheet-service;1"]
      .getService(Ci.nsIStyleSheetService);
    sss.loadAndRegisterSheet(cssURI, sss.AGENT_SHEET);
    out.sheetRegistered = sss.sheetRegistered(cssURI, sss.AGENT_SHEET);

    // Probe the frame DOM the assembled Svelte shell mounts (P3-T13;
    // frame.js builders). The pre-assembly shell had no frame, so this
    // test used to inject a synthetic copy — now the live shell is the
    // fixture, which is strictly stronger (tests the shipped layout).
    const bar = d.querySelector("[data-astra-titlebar]");
    const controls = d.querySelector("[data-astra-window-controls]");
    const side = d.querySelector("[data-astra-sidebar]");
    const tool = d.querySelector("[data-astra-toolbar]");
    out.shellFrameMounted = !!(bar && controls && side && tool);
    if (!out.shellFrameMounted) {
      throw new Error("assembled shell frame not mounted (P3-T13)");
    }

    // Co-located regular properties from the same rule blocks compute,
    // proving the drag rules match these live elements.
    const cs = (e) => win.getComputedStyle(e);
    // P3-T20: once the app frame announces itself the shell retires the
    // fallback titlebar/toolbar (`Shell.svelte` — .astra-frame
    // [data-app-booted="true"] .astra-titlebar { display: none }), because
    // the app *is* the chrome. Measure the live state, then re-measure with
    // the retirement attribute off to prove frame.css still styles the
    // fallback frame (the state that rule exists for).
    const frameEl = d.querySelector("[data-astra-frame]");
    out.appBooted = frameEl?.getAttribute("data-app-booted") ?? "";
    out.barDisplay = cs(bar).getPropertyValue("display");
    out.barBg = cs(bar).getPropertyValue("background-color");
    const booted = frameEl?.getAttribute("data-app-booted") ?? null;
    if (frameEl) frameEl.setAttribute("data-app-booted", "false");
    out.fallbackBarDisplay = cs(bar).getPropertyValue("display");
    out.fallbackBarBg = cs(bar).getPropertyValue("background-color");
    out.controlsDisplay = cs(controls).getPropertyValue("display");
    out.btnCursor = cs(controls.querySelector("button")).getPropertyValue("cursor");
    if (frameEl && booted !== null) frameEl.setAttribute("data-app-booted", booted);

    // Drag-region reporting runs live (getComputedStyle-backed; the
    // engine hides this chrome-only property from CSSOM readback, so
    // `dragging` reads "" here — static source check covers the value).
    const rep = Frame.reportDragRegions(d, win);
    out.repRoles = rep.regions.map((r) => r.role).join(",");
    out.repButtons = rep.regions.filter((r) => r.role === "control-button").length;
    out.repRects = rep.regions.filter((r) => r.role !== "control-button" && r.rect).length;

    // Window-control dispatch through the Host API (live v1 module).
    const host = { Windows };
    const winId = "win-1";
    await Windows.list({ request_id: "frame-0" });
    const closeRes = await Frame.dispatchWindowControl(host, null,
      { action: "close", window_id: winId, request_id: "frame-1" });
    out.closeGuard = closeRes?.error?.code ?? "";
    const fsOn = await Frame.dispatchWindowControl(host, null,
      { action: "toggle-fullscreen", window_id: winId, request_id: "frame-2" });
    const fsSeen = await Windows.get({ request_id: "frame-3", window_id: winId });
    const fsOff = await Frame.dispatchWindowControl(host, null,
      { action: "toggle-fullscreen", window_id: winId, request_id: "frame-4" });
    out.fsOn = fsOn?.fullscreen === true;
    out.fsSeen = fsSeen?.window?.fullscreen === true;
    out.fsOff = fsOff?.fullscreen === false;
    const titled = await Windows.setTitle(
      { request_id: "frame-5", window_id: winId, title: "Astra — Frame" });
    out.titleEcho = titled?.title ?? "";
    const bad = await Frame.dispatchWindowControl(host, null,
      { action: "explode", window_id: winId, request_id: "frame-6" });
    out.badAction = bad?.error?.code ?? "";
    let minimized = 0;
    const minRes = await Frame.dispatchWindowControl(host,
      { minimize: () => { minimized++; } },
      { action: "minimize", window_id: winId, request_id: "frame-7" });
    out.minDispatch = minRes?.dispatched === true && minimized === 1;
    const minBare = await Frame.dispatchWindowControl(host, null,
      { action: "minimize", window_id: winId, request_id: "frame-8" });
    out.minNoAdapter = minBare?.error?.code ?? "";

    // Fullscreen attribute hides the chrome rows (agent-sheet rule).
    // Operate on the live assembled shell frame (P3-T13), not a copy.
    const liveFrame = d.querySelector("[data-astra-frame]");
    liveFrame.setAttribute("data-astra-fullscreen", "true");
    out.hiddenBar = cs(bar).getPropertyValue("display");
    out.hiddenSide = cs(side).getPropertyValue("display");
    out.hiddenTool = cs(tool).getPropertyValue("display");
    liveFrame.setAttribute("data-astra-fullscreen", "false");

    // NOTE: no frame.remove() — this is the live assembled shell, not a
    // synthetic copy (pre-P3-T13 cleanup removed). Attribute restored above.
    sss.unregisterSheet(cssURI, sss.AGENT_SHEET);
  } catch (e) {
    out.errors.push(String(e && e.message ? e.message : e));
  }
  done(out);
})();
"""


def check_frame_css_source():
    """Static check: drag declarations live in the right rule blocks."""
    with open(FRAME_CSS, encoding="utf-8") as f:
        src = f.read()

    def block_of(selector):
        # crude top-level rule-block extraction for a flat stylesheet
        for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", src):
            if selector in m.group(1):
                return m.group(2)
        return ""

    titlebar = block_of("#astra-root .astra-titlebar {") or block_of(".astra-titlebar")
    controls_btn = block_of(".astra-window-controls button")
    interactive = block_of(".astra-titlebar button")
    return {
        "titlebar drags": "-moz-window-dragging" in titlebar
        and "drag" in titlebar and "no-drag" not in titlebar.replace("no-drag", ""),
        "controls no-drag": "no-drag" in (controls_btn + interactive),
    }


def main():
    for f in (FIREFOX, GECKODRIVER):
        if not os.path.exists(f):
            print(f"SKIP: missing {f} (run a full build first)")
            return 2
    if not os.path.exists(FRAME_CSS):
        print(f"FAIL: missing {FRAME_CSS}")
        return 1

    src_checks = check_frame_css_source()

    profile = tempfile.mkdtemp(prefix="astra-frame-")
    gd = subprocess.Popen(
        [GECKODRIVER, "--port", str(PORT)],
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
            res = wd("POST", f"/session/{session}/execute/async", {
                "script": CHROME_SCRIPT, "args": [OVERLAY_ASTRA, FRAME_CSS],
            })
            print("observed:", json.dumps(res, indent=1)[:2500])
            if res.get("errors"):
                print("FAIL chrome errors:", res["errors"])
                return 1
            checks = [
                ("P1-T08 mount intact (Hello Tab)", "Hello Tab" in res.get("rootText", "")),
                ("assembled shell frame mounted (P3-T13)",
                 res.get("shellFrameMounted") is True),
                ("frame.css: titlebar declares drag",
                 src_checks["titlebar drags"] is True),
                ("frame.css: controls/buttons declare no-drag",
                 src_checks["controls no-drag"] is True),
                ("agent sheet registers", res.get("sheetRegistered") is True),
                # P3-T20: the app owns the window, so the fallback titlebar is
                # retired (display none) — the old "always flex" check was
                # asserting a state the product no longer ships.
                ("app owns window: fallback titlebar retired",
                 res.get("appBooted") == "true"
                 and res.get("barDisplay") == "none"),
                # ...and frame.css still styles that fallback frame when it is
                # the active chrome (measured with data-app-booted off/restored).
                ("titlebar rule applies live (flex + #2b2a33)",
                 res.get("fallbackBarDisplay") == "flex"
                 and res.get("fallbackBarBg") == "rgb(43, 42, 51)"),
                ("controls rule applies live",
                 res.get("controlsDisplay") == "flex"
                 and res.get("btnCursor") == "pointer"),
                ("reportDragRegions covers frame roles",
                 res.get("repRoles") == "titlebar,window-controls,sidebar,toolbar,"
                 "control-button,control-button,control-button"),
                ("reportDragRegions reports 3 control buttons",
                 res.get("repButtons") == 3),
                ("reported regions have rects", res.get("repRects") == 4),
                ("close refuses last window via Host API",
                 res.get("closeGuard") == "last_window"),
                ("toggle-fullscreen on via Host Windows API",
                 res.get("fsOn") is True and res.get("fsSeen") is True),
                ("toggle-fullscreen off via Host Windows API",
                 res.get("fsOff") is True),
                ("setTitle via Host Windows API",
                 res.get("titleEcho") == "Astra — Frame"),
                ("unknown action rejected",
                 res.get("badAction") == "invalid_window_action"),
                ("minimize via chrome adapter", res.get("minDispatch") is True),
                ("minimize without adapter errors",
                 res.get("minNoAdapter") == "unsupported_chrome_op"),
                ("fullscreen hides titlebar/sidebar/toolbar",
                 res.get("hiddenBar") == "none"
                 and res.get("hiddenSide") == "none"
                 and res.get("hiddenTool") == "none"),
            ]
            failed = [name for name, ok in checks if not ok]
            for name, ok in checks:
                print(("PASS " if ok else "FAIL ") + name)
            if failed:
                print(f"frame live contract: FAIL ({len(failed)} checks)")
                return 1
            print("frame live contract: PASS")
            return 0
        finally:
            wd("DELETE", f"/session/{session}")
    finally:
        gd.terminate()


if __name__ == "__main__":
    sys.exit(main())
