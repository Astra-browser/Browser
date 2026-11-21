#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Real-web YouTube ad probe (diagnostic, network dependent).

Loads a watch page, watches the player for ad markers, then reloads the same
tab and watches again. Evidence only: it needs the live web, so it is not part
of the canonical gate.

Usage: python3 tools/marionette-probe/youtube-ads-probe.py [url]
"""
import json, os, socket, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

FIREFOX = astra_env.BINARY
PORT = 2894
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FLAGS = {a for a in sys.argv[1:] if a.startswith("--")}
URL = ARGS[0] if ARGS else "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
SECONDS = int(next((a.split("=", 1)[1] for a in FLAGS if a.startswith("--seconds=")), "30"))
RELOAD_ONLY = "--reload-only" in FLAGS


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c:
                raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c:
                raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]

    def js(self, s, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": args or []})["value"]

    def chrome(self):
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def content(self):
        self.cmd("Marionette:SetContext", {"value": "content"})


def wait(fn, timeout=90, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


HANDLE = r"""
const { NavigableManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/NavigableManager.sys.mjs");
return NavigableManager.getIdForBrowser(window.gBrowser.selectedBrowser);
"""

SAMPLE = r"""
const player = document.getElementById("movie_player");
const video = document.querySelector("video");
return JSON.stringify({
  url: location.href,
  ready: document.readyState,
  hasPlayer: !!player,
  adShowing: !!player && player.classList.contains("ad-showing"),
  adInterrupting: !!document.querySelector(".ad-interrupting"),
  adModules: document.querySelectorAll(".ytp-ad-module, .ytp-ad-overlay-slot, .ytp-ad-player-overlay").length,
  playerResponse: !!window.ytInitialPlayerResponse,
  adPlacements: (() => {
    const r = window.ytInitialPlayerResponse;
    if (!r) return null;
    try { return JSON.stringify(r.adPlacements ?? null).slice(0, 80); } catch (e) { return String(e); }
  })(),
  videoTime: video ? Math.round(video.currentTime * 10) / 10 : null,
  paused: video ? video.paused : null,
  jsonParseProxied: !/\[native code\]/.test(String(JSON.parse)),
  adMedia: performance.getEntriesByType("resource")
    .map((e) => e.name)
    .filter((n) => /videoplayback/.test(n) && /(adformat|ctier|ptype)/.test(n))
    .slice(0, 6),
  adHosts: (() => {
    try {
      return [...new Set(performance.getEntriesByType("resource").map((e) => new URL(e.name).host))]
        .filter((h) => /google|doubleclick|gstatic|ytimg/.test(h)).slice(0, 20);
    } catch (e) { return [String(e)]; }
  })(),
  loaded: performance.getEntriesByType("resource").length,
});
"""

STATS = r"""
const s = Cc["@astra/blocker;1"].getService(Ci.nsIAstraBlockerService);
return s.stats();
"""

SCRIPLETS = r"""
const s = Cc["@astra/blocker;1"].getService(Ci.nsIAstraBlockerService);
const v = JSON.parse(s.cosmeticFor(arguments[0], "[]", "[]"));
const calls = (v.script || "").match(/try \{\n([a-zA-Z_$][\w$]*\([^\n]*)\n\} catch/g) || [];
return JSON.stringify({len: (v.script || "").length, calls: calls.map((c) => c.split("\n")[1])});
"""

WATCH_NET = r"""
if (!window.__astraProbeNet) {
  window.__astraProbeNet = [];
  const log = (spec) => window.__astraProbeNet.push(spec);
  Services.obs.addObserver(function (subject) {
    try {
      const ch = subject.QueryInterface(Ci.nsIHttpChannel);
      const spec = ch.URI.spec;
      if (/googlevideo|doubleclick|googleads|adsystem|adformat/.test(spec)) {
        log(spec.slice(0, 400));
      }
    } catch (e) {}
  }, "http-on-modify-request");
}
return window.__astraProbeNet.length;
"""

DUMP_NET = r"""
const rows = (window.__astraProbeNet || []).slice();
window.__astraProbeNet = [];
return JSON.stringify(rows.slice(-40));
"""


def sample(m):
    try:
        return json.loads(m.js(SAMPLE))
    except Exception as e:  # navigation in flight
        return {"error": str(e)}


def watch(m, seconds):
    rows = []
    for _ in range(seconds):
        time.sleep(1.0)
        rows.append(sample(m))
    return rows


def summarize(name, rows):
    ads = sum(1 for r in rows if r.get("adShowing") or r.get("adInterrupting"))
    overlays = sum(1 for r in rows if (r.get("adModules") or 0) > 0)
    placements = sum(1 for r in rows if r.get("adPlacements") not in (None, "null", "undefined"))
    times = [r.get("videoTime") for r in rows if r.get("videoTime") is not None]
    progressed = (max(times) - min(times)) if times else 0
    ad_media = sorted({u for r in rows for u in (r.get("adMedia") or [])})
    print(json.dumps({
        "phase": name,
        "samples": len(rows),
        "ad_samples": ads,
        "overlay_samples": overlays,
        "placement_samples": placements,
        "progress_seconds": progressed,
        "ad_media": [u[:140] for u in ad_media[-4:]],
        "jsonParseProxied": rows[-1].get("jsonParseProxied") if rows else None,
        "last": rows[-1],
    }))
    return ad_media


def verdicts(m, urls):
    m.chrome()
    out = []
    for u in urls[-6:]:
        out.append(json.loads(m.js(
            "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService);"
            "return s.checkUrl(arguments[0], 'https://www.youtube.com/', 'media');", [u])))
    return out


profile = tempfile.mkdtemp(prefix="astra-youtube-ads-")
with open(os.path.join(profile, "prefs.js"), "w") as f:
    f.write(f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
            'user_pref("media.volume_scale", "0.0");\n'
            'user_pref("media.autoplay.default", 0);\n'
            'user_pref("media.autoplay.blocking_policy", 0);\n'
            'user_pref("media.autoplay.block-webaudio", false);\n')
log = open(os.path.join(profile, "log"), "wb")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
)
try:
    m = M(PORT)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.chrome()
    wait(lambda: m.js("return !!Services?.astraHost;"), 90)
    m.js("return Services.astraHost.Blocker.status().then(s => s.protection);")
    active = wait(lambda: m.js(
        "return Services.astraHost.Blocker.status().then(s => s.protection === 'active' ? 'yes' : '');"
    ), 120)
    print("active:", active)

    handle = wait(lambda: m.js(HANDLE) or None, 20)
    m.js(WATCH_NET)
    m.content()
    m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": True})
    m.js("location.assign(arguments[0]); return true;", [URL])
    wait(lambda: (sample(m).get("ready") == "complete" and sample(m).get("hasPlayer")), 60)
    if RELOAD_ONLY:
        time.sleep(2.0)
    else:
        first_ads = summarize("first-load", watch(m, SECONDS))
        print("verdicts-first", json.dumps(verdicts(m, first_ads))[:800])
        m.chrome()
        print("net-first", m.js(DUMP_NET)[:900])

    m.chrome()
    stats1 = json.loads(m.js(STATS))
    print("stats-after-first", json.dumps(stats1))
    print("scriptlets", m.js(SCRIPLETS, [URL])[:700])
    cycles = int(next((a.split("=", 1)[1] for a in FLAGS if a.startswith("--cycles=")), "1"))
    for cycle in range(1, cycles + 1):
        m.content()
        m.js("location.reload(); return true;")
        time.sleep(1.0)
        wait(lambda: (sample(m).get("ready") == "complete" and sample(m).get("hasPlayer")), 60)
        reload_ads = summarize(f"after-reload-{cycle}", watch(m, SECONDS))
        if reload_ads:
            m.chrome()
            print("verdicts", json.dumps(verdicts(m, reload_ads))[:400])
        m.chrome()
        print("stats", json.dumps(json.loads(m.js(STATS))))
    m.chrome()
    print("net-reload", m.js(DUMP_NET)[:600])
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
