#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Optional real-site blocker probe (D-42).

Loads ad-heavy pages and YouTube in a throwaway, hard-muted profile
(`media.volume_scale="0.0"`, every tab `audioMuted`, video `muted` before
play). It reports:

  * blocked/decision deltas from the native engine for each page;
  * tracker resource-timing entries with transferSize (0 = never loaded);
  * ad-like elements that remain visible (0 = cosmetic filtering worked);
  * YouTube playback and ad state, with the element muted.

Network-dependent, so it is not in the canonical full suite. It never touches
another Firefox process: its profile is a unique temp dir and it only exits its
own child process.

Usage: python3 tools/marionette-probe/real-sites-probe.py
Exit: 0 when every page loaded and YouTube played; 1 otherwise.
"""
import json, os, socket, subprocess, tempfile, time, sys

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2911

SITES = [
    ("speedtest", "https://www.speedtest.net/"),
    ("verge", "https://www.theverge.com/"),
    ("cnn", "https://www.cnn.com/"),
    ("forbes", "https://www.forbes.com/"),
    ("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
]

TRACKER_PATTERNS = [
    "doubleclick.net", "googlesyndication.com", "google-analytics.com",
    "googletagmanager.com", "googletagservices.com", "adservice.google.com",
    "facebook.net", "connect.facebook.net", "facebook.com/tr",
    "scorecardresearch.com", "taboola.com", "outbrain.com", "criteo.com",
    "adnxs.com", "amazon-adsystem.com", "moatads.com", "adsrvr.org",
    "rubiconproject.com", "pubmatic.com", "openx.net", "quantserve.com",
    "hotjar.com", "segment.com", "branch.io", "ads-twitter.com",
    "analytics.twitter.com", "tiktok.com", "ads.tiktok.com",
    "bing.com/bat.js", "clarity.ms", "sentry.io", "newrelic.com",
    "nr-data.net", "optimizely.com", "chartbeat.com", "parsely.com",
]


class M:
    def __init__(self, port):
        end = time.time() + 120
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


def wait(fn, timeout=60, step=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


CONTENT_JS = r"""
const entries = performance.getEntriesByType('resource').map(e => e.name);
const hosts = [...new Set(entries.map(u => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean))];
const adEls = [...document.querySelectorAll(
  '[id*="google_ads"], [id*="div-gpt-ad"], [class*="ad-slot"], [class*="advertisement"], ' +
  '[data-ad-slot], iframe[src*="doubleclick"], iframe[src*="googlesyndication"], ' +
  '.ytp-ad, .ytp-ad-module, .ad-showing'
)];
const adLike = adEls.slice(0, 20).map(el => (el.id || el.className || el.tagName || '').toString().slice(0, 100));
const visibleAdLike = adEls.filter(el => {
  try {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 2 && r.height > 2;
  } catch { return false; }
}).length;
const video = document.querySelector('video');
return JSON.stringify({
  url: location.href,
  title: document.title,
  ready: document.readyState,
  entries: entries.length,
  hosts,
  adLike,
  visibleAdLike,
  resourceDetails: performance.getEntriesByType('resource')
    .filter(e => /doubleclick|googlesyndication|googletag|google-analytics|amazon-adsystem|adnxs|rubicon|chartbeat|optimizely|criteo|taboola|outbrain|scorecardresearch|quantserve|hotjar|clarity|facebook/i.test(e.name))
    .slice(0, 40)
    .map(e => ({name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, duration: Math.round(e.duration), responseStatus: e.responseStatus ?? null})),
  bodyChars: (document.body ? document.body.innerText.length : 0),
  video: video ? {
    readyState: video.readyState,
    paused: video.paused,
    muted: video.muted,
    currentTime: video.currentTime,
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
  } : null,
  adShowing: !!document.querySelector('.ad-showing'),
  adOverlay: !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-module'),
});
"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-real-sites-")
    prefs = [
        f'user_pref("marionette.port", {PORT});',
        'user_pref("media.volume_scale", "0.0");',
        'user_pref("media.autoplay.default", 5);',
        'user_pref("media.autoplay.blocking_policy", 2);',
        'user_pref("datareporting.healthreport.uploadEnabled", false);',
    ]
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write("\n".join(prefs) + "\n")
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    results = []
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        wait(lambda: m.js("return !!Services?.astraHost;"), 90)
        # Hard silence: string pref, verified, and every native tab muted.
        m.js("""
          Services.prefs.setStringPref('media.volume_scale', '0.0');
          const w=Services.wm.getMostRecentWindow('navigator:browser');
          if (w?.gBrowser) for (const t of w.gBrowser.tabs) { try { t.linkedBrowser.audioMuted = true; } catch {} }
          return Services.prefs.getStringPref('media.volume_scale', '1.0');
        """)
        m.js("return Services.astraHost.Blocker.status().then(s => s.protection);")
        active = wait(
            lambda: m.js(
                "return Services.astraHost.Blocker.status().then(s => s.protection === 'active' ? 'yes' : '');"
            ),
            180,
        )
        print("BLOCKER ACTIVE:", active, flush=True)

        for name, url in SITES:
            before = json.loads(m.js(
                "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService); return s.stats();"
            ))
            nav = m.js(
                "return Services.astraHost.Navigation.loadURL({request_id:arguments[0], astra_tab_id:arguments[1], url:arguments[2]});",
                [f"nav-{name}", m.js("return Services.astraHost.Tabs.list({request_id:'sel'}).then(r => r.selected_tab_id);"), url],
            )
            # Mute the tab before any media can play and keep it muted.
            muted_now = m.js(
                "const w=Services.wm.getMostRecentWindow('navigator:browser');"
                "const b=w?.gBrowser?.selectedBrowser; if (!b) return false;"
                "b.audioMuted=true; return b.audioMuted;"
            )
            # Wait for a real document and a little settling time.
            wait(lambda: m.js("const w=Services.focus.activeWindow; return w?.gBrowser?.selectedBrowser?.contentDocument?.readyState === 'complete' ? 'yes' : '';"), 45)
            time.sleep(6)
            m.cmd("Marionette:SetContext", {"value": "content"})
            try:
                data = json.loads(m.js(CONTENT_JS))
            except Exception as e:
                data = {"error": str(e), "url": "", "hosts": [], "entries": 0}
            # YouTube: make sure it is playing, muted, and never audible.
            if name == "youtube" and data.get("video"):
                try:
                    m.js("const v=document.querySelector('video'); if(v){v.muted=true; v.play().catch(()=>{});} return true;")
                    time.sleep(4)
                    data["videoAfter"] = json.loads(m.js(
                        "const v=document.querySelector('video'); return JSON.stringify(v ? {paused:v.paused, muted:v.muted, currentTime:v.currentTime, duration:v.duration, readyState:v.readyState} : null);"
                    ))
                except Exception as e:
                    data["videoError"] = str(e)
                # Trusted click on YouTube's play control if autoplay was refused.
                try:
                    still_paused = m.js("const v=document.querySelector('video'); return v ? v.paused : true;")
                    if still_paused:
                        target = m.cmd("WebDriver:FindElement", {"using": "css selector", "value": ".ytp-play-button, video"})
                        m.cmd("WebDriver:ElementClick", {"id": target["element-6066-11e4-a52e-4f735466cecf"]})
                        time.sleep(5)
                        data["videoAfterClick"] = json.loads(m.js(
                            "const v=document.querySelector('video'); return JSON.stringify(v ? {paused:v.paused, muted:v.muted, currentTime:v.currentTime, duration:v.duration, readyState:v.readyState} : null);"
                        ))
                except Exception as e:
                    data["clickError"] = str(e)
            m.cmd("Marionette:SetContext", {"value": "chrome"})
            muted = m.js("const w=Services.wm.getMostRecentWindow('navigator:browser'); return w?.gBrowser?.selectedBrowser?.audioMuted === true;")
            after = json.loads(m.js(
                "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService); return s.stats();"
            ))
            hits = []
            for host in data.get("hosts", []):
                lower = host.lower()
                for pattern in TRACKER_PATTERNS:
                    if pattern in lower:
                        hits.append(host)
                        break
            results.append({
                "name": name,
                "requested": url,
                "muted": muted,
                "blockedDelta": after.get("blocks", 0) - before.get("blocks", 0),
                "decisionsDelta": after.get("decisions", 0) - before.get("decisions", 0),
                "trackerHostsSeen": sorted(set(hits)),
                "data": data,
            })
            print(f"\n== {name} == {data.get('url','')} | {data.get('title','')}")
            print(f"  ready={data.get('ready')} entries={data.get('entries')} bodyChars={data.get('bodyChars')} muted={muted}")
            print(f"  blockedDelta={results[-1]['blockedDelta']} decisionsDelta={results[-1]['decisionsDelta']}")
            print(f"  trackerHostsSeen={results[-1]['trackerHostsSeen']}")
            print(f"  adLike={len(data.get('adLike', []))} visible={data.get('visibleAdLike')}")
            print(f"  trackerDetails={[(d['name'][:60], d['transferSize'], d['duration']) for d in data.get('resourceDetails', [])[:12]]}")
            print(f"  video={data.get('video')} after={data.get('videoAfter')} afterClick={data.get('videoAfterClick')} adShowing={data.get('adShowing')} adOverlay={data.get('adOverlay')}")
            sys.stdout.flush()

        print("\n=== SUMMARY ===")
        print(json.dumps([{
            "name": r["name"],
            "url": r["data"].get("url"),
            "title": r["data"].get("title"),
            "entries": r["data"].get("entries"),
            "blockedDelta": r["blockedDelta"],
            "decisionsDelta": r["decisionsDelta"],
            "trackerHostsSeen": r["trackerHostsSeen"],
            "adLikeCount": len(r["data"].get("adLike", [])),
            "video": r["data"].get("videoAfter") or r["data"].get("video"),
            "muted": r["muted"],
        } for r in results], indent=2))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    main()
