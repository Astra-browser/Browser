#!/usr/bin/env python3
"""YouTube auto-PiP: does leaving a playing video actually open the player?

Reproduces the owner report ("sometimes says the video is playing in
Picture-in-Picture but the popup does not open, hit or miss") on the real site
in a throwaway, hard-muted profile:

  - opens a YouTube watch page and plays the main video,
  - switches to a silent tab (the automatic path) several rounds,
  - clicks the sidebar's PiP control from the playing tab several rounds,
  - records, after every attempt: the player window (and whether the compositor
    mapped it), the native tab marker, the source docshell, the media
    controller and whether the video is actually being cloned.

It also prints the element state YouTube leaves behind, which is what
`findVideoToPiP` / `videoIsPiPEligible` see (several previews and an ad video
share the page with the main one).

  python3 tools/marionette-probe/youtube-autopip-probe.py [rounds]
Exit 0 when every round opened a mapped player, 1 otherwise, 2 SKIP when the
page never played (network, consent wall or no media device).
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
MPORT = 2987
WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 3

sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

profile = tempfile.mkdtemp(prefix="astra-yt-pip-")
open(os.path.join(profile, "user.js"), "w").write(
    f'user_pref("marionette.port", {MPORT});\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("media.autoplay.default", 0);\n'
    'user_pref("media.autoplay.blocking_policy", 0);\n'
    'user_pref("media.volume_scale", "0.0");\n'
    'user_pref("media.videocontrols.picture-in-picture.enabled", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true);\n'
)
log = open(os.path.join(profile, "browser.log"), "wb")
proc = subprocess.Popen(
    [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
    start_new_session=True,
)

PLAY = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    for (let i = 0; i < 120; i++) {
      const v = document.querySelector('video.html5-main-video') ||
                document.querySelector('video');
      if (v) {
        v.muted = true;
        try { v.play(); } catch (e) {}
        for (let j = 0; j < 40 && v.paused; j++) await wait(250);
        done(JSON.stringify({
          found: true, paused: v.paused, readyState: v.readyState,
          duration: v.duration, title: document.title,
        }));
        return;
      }
      await wait(250);
    }
    done(JSON.stringify({ found: false, title: document.title }));
  } catch (e) { done(JSON.stringify({ found: false, error: String(e) })); }
})();
"""

ELEMENTS = r"""
const done = arguments[arguments.length - 1];
try {
  const list = [...document.querySelectorAll('video')].map(v => ({
    paused: v.paused, ended: v.ended, readyState: v.readyState,
    duration: Number.isFinite(v.duration) ? v.duration : null,
    disablePictureInPicture: v.disablePictureInPicture,
    cloning: v.isCloningElementVisually,
    width: v.videoWidth, height: v.videoHeight,
    cls: v.className.slice(0, 40),
    active: document.activeElement === v,
  }));
  done(JSON.stringify(list));
} catch (e) { done(JSON.stringify({ error: String(e) })); }
"""

CHROME = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let host = null;
  for (let i = 0; i < 80; i++) {
    host = Services.astraHost;
    if (host?.Media && host?.Tabs) break;
    await wait(250);
  }
  const a = (await host.Tabs.create({ request_id: "yt", url: __WATCH__, background: false })).astra_tab_id;
  for (let i = 0; i < 120; i++) {
    const t = (await host.Tabs.list({ request_id: "yt-list" })).tabs?.find(x => x.astra_tab_id === a);
    if (t && t.loading === false) break;
    await wait(250);
  }
  await wait(4000);
  // The content handle marionette needs for a script in the page: SwitchToWindow
  // accepts the navigable id, which the same module computes for this browser.
  const tab = [...gBrowser.tabs].find(t => t.getAttribute("astra-tab-id") === a);
  const { NavigableManager } = ChromeUtils.importESModule(
    "chrome://remote/content/shared/NavigableManager.sys.mjs");
  done(JSON.stringify({
    ready: true, tab: a,
    handle: NavigableManager.getIdForBrowser(tab?.linkedBrowser),
  }));
})()
"""

def main():
    m = L.Marionette(MPORT, timeout=180)
    m.sock.settimeout(300)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("WebDriver:SetTimeouts", {"script": 180000, "implicit": 0, "pageLoad": 90000})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(5)
    chrome_handle = m.cmd("WebDriver:GetWindowHandle")["value"]

    # Open the watch page through the host, then play in content.
    setup = json.loads(m.execute_async(CHROME.replace("__WATCH__", json.dumps(WATCH))))
    tab_id = setup["tab"]
    m.cmd("WebDriver:SwitchToWindow", {"handle": setup["handle"], "focus": True})
    m.cmd("Marionette:SetContext", {"value": "content"})
    played = json.loads(m.execute_async(PLAY))
    elements = json.loads(m.execute_async(ELEMENTS))
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    m.cmd("WebDriver:SwitchToWindow", {"handle": chrome_handle, "focus": True})
    if not played.get("found") or played.get("paused"):
        print(json.dumps({"skip": "the watch page never played", "played": played,
                          "elements": elements}, indent=2))
        return 2

    js = (
        CHROME_RUN
        .replace("__TAB__", json.dumps(tab_id))
        .replace("__ROUNDS__", str(ROUNDS))
        .replace("__ELEMENTS__", json.dumps(elements))
    )
    out = json.loads(m.execute_async(js))
    out["played"] = played
    print(json.dumps(out, indent=2))
    ok = all(r.get("opened") and r.get("mapped") for r in out.get("rounds", []))
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


CHROME_RUN = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const tabId = __TAB__;
  const rounds = __ROUNDS__;
  let host = null;
  for (let i = 0; i < 80; i++) {
    host = Services.astraHost;
    if (host?.Media && host?.Tabs) break;
    await wait(250);
  }
  const { PictureInPicture } = ChromeUtils.importESModule(
    "resource://gre/modules/PictureInPicture.sys.mjs");
  const pipWins = () =>
    [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].filter(w => !w.closed);
  const tabOf = id => [...gBrowser.tabs].find(t => t.getAttribute("astra-tab-id") === id);
  const windowState = win => {
    const r = { closed: win?.closed === true };
    if (!win || win.closed) return r;
    try { r.windowState = win.windowState; } catch (e) { r.windowState = null; }
    try { r.visible = win.document?.visibilityState ?? null; } catch (e) {}
    try { r.screen = [win.screenX, win.screenY, win.innerWidth, win.innerHeight]; } catch (e) {}
    try { r.occluded = win.isFullyOccluded ?? null; } catch (e) {}
    return r;
  };
  const observe = label => {
    const tab = tabOf(tabId);
    const browser = tab?.linkedBrowser;
    let media = { active: null, playing: null };
    try {
      const c = browser?.browsingContext?.mediaController;
      media = { active: c?.isActive === true, playing: c?.isPlaying === true };
    } catch (e) {}
    const wins = pipWins();
    return {
      label, wins: wins.length, win: wins[0] ? windowState(wins[0]) : null,
      tabPip: tab?.hasAttribute("pictureinpicture") === true,
      docShell: browser?.docShellIsActive === true,
      media, suppressed: PictureInPicture.isAutoPipSuppressed(browser) === true,
    };
  };
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await wait(150); }
    return false;
  };
  const closePip = async () => {
    for (const w of pipWins()) { try { w.close(); } catch (e) {} }
    await waitFor(() => pipWins().length === 0, 8000);
    await wait(600);
  };

  const out = { rounds: [], auto: [], card: [], elements: __ELEMENTS__ };
  const silent = (await host.Tabs.create({
    request_id: "yt-silent", url: "about:blank", background: false })).astra_tab_id;
  await wait(1500);

  for (let i = 0; i < rounds; i++) {
    await host.Tabs.select({ request_id: "yt-back-" + i, astra_tab_id: tabId });
    await wait(1200);
    const before = observe("before-" + i);
    // The automatic path: select away from the playing tab.
    await host.Tabs.select({ request_id: "yt-away-" + i, astra_tab_id: silent });
    const opened = await waitFor(() => pipWins().length > 0, 6000);
    await wait(600);
    const after = observe("after-" + i);
    const win = pipWins()[0] ?? null;
    out.auto.push({
      round: i, opened, mapped: !!(win && !win.closed &&
        (() => { try { return win.windowState === 0 || win.windowState === 1; } catch (e) { return false; } })()),
      before, after,
    });
    await closePip();
  }

  // The card's control from the playing tab (the person's own path).
  await host.Tabs.select({ request_id: "yt-card-tab", astra_tab_id: tabId });
  await wait(1500);
  for (let i = 0; i < rounds; i++) {
    if (pipWins().length) await closePip();
    const res = await host.Media.player({
      id: tabId, action: { kind: "picture_in_picture" } });
    const opened = await waitFor(() => pipWins().length > 0, 6000);
    await wait(500);
    const win = pipWins()[0] ?? null;
    const raised = await host.Media.player({
      id: tabId, action: { kind: "picture_in_picture" } });
    await wait(500);
    out.card.push({
      round: i, accepted: res?.accepted === true, opened,
      stillOne: pipWins().length === 1, closed: win?.closed === true,
      raisedaccepted: raised?.accepted === true, after: observe("card-" + i),
    });
    await closePip();
  }

  for (const w of pipWins()) { try { w.close(); } catch (e) {} }
  await wait(600);
  out.leaked = pipWins().length;
  done(JSON.stringify(out));
})()
"""


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception as exc:  # a probe that dies still has to clean up
        print(f"youtube-autopip-probe: ERROR — {exc}", file=sys.stderr)
        code = 1
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
        shutil.rmtree(profile, ignore_errors=True)
    sys.exit(code)
