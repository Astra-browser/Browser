#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Real-web ad-block benchmark probe.

Runs the packaged Astra dev build against:
  * https://adblock.turtlecute.org/ (128 ad/tracker hosts, HEAD fetches)
  * https://www.youtube.com/watch?v=QzqaZshQcJI (pre-roll ad state)

Evidence written to out/adblock-benchmark/:
  * turtlecute.png / youtube.png       (full-window screenshots)
  * report.json                         (scores, failed hosts, engine counts)

Usage: tools/perf/hidden-display.sh python3 tools/marionette-probe/adblock-benchmark-probe.py
Exit 0 only when the benchmark reaches 100% and YouTube shows no ad module.
"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2893
OUT = os.path.join(ROOT, "out", "adblock-benchmark")
TURTLECUTE = "https://adblock.turtlecute.org/"
YOUTUBE = "https://www.youtube.com/watch?v=QzqaZshQcJI"


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

    def content(self):
        self.cmd("Marionette:SetContext", {"value": "content"})

    def chrome(self):
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def shot(self, name):
        data = self.cmd("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        raw = base64.b64decode(data["value"])
        path = os.path.join(OUT, name)
        with open(path, "wb") as f:
            f.write(raw)
        return path


def wait(fn, timeout=90, step=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="astra-adbench-")
with open(os.path.join(profile, "prefs.js"), "w") as f:
    f.write(f'user_pref("marionette.port", {PORT});\n')
    # Keep the benchmark deterministic and silent.
    f.write('user_pref("media.volume_scale", "0.0");\n')
    f.write('user_pref("media.autoplay.default", 0);\n')
    f.write('user_pref("media.autoplay.blocking_policy", 0);\n')
log = open(os.path.join(profile, "log"), "wb")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
)
report = {"turtlecute": {}, "youtube": {}, "engine": {}}
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def navigate(m, url):
    tab = m.js("return Services.astraHost.Tabs.list({request_id:'id'}).then(r => r.selected_tab_id);")
    return m.js(
        "return Services.astraHost.Navigation.loadURL({request_id:'live', astra_tab_id:arguments[0], url:arguments[1]});",
        [tab, url],
    )


try:
    m = M(PORT)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.chrome()
    wait(lambda: m.js("return !!Services?.astraHost;"), 120)

    active = wait(
        lambda: m.js(
            "return Services.astraHost.Blocker.status().then(s => s.protection === 'active' ? 'yes' : '');"
        ),
        120,
    )
    check("blocker active on a fresh profile", active == "yes")

    before = json.loads(
        m.js("return Services.astraHost.Blocker.lists().then(v => JSON.stringify(v));")
    )
    report["engine"]["before_refresh"] = {
        "enabled_lists": sum(1 for x in before.get("lists", []) if x.get("enabled")),
        "installed_rules": before.get("installed_rules"),
        "stats": before.get("stats"),
    }

    # Install every default list from the network before measuring. The
    # bundled seed only carries EasyList/EasyPrivacy.
    refresh = json.loads(
        m.js("return Services.astraHost.Blocker.refreshSources().then(v => JSON.stringify(v));")
    )
    check("refresh sources accepted", refresh.get("accepted") is True, json.dumps(refresh)[:300])
    status = wait(
        lambda: m.js(
            "return Services.astraHost.Blocker.status().then(s =>"
            " (s.source_phase === 'fresh' || s.source_phase === 'failed') ? JSON.stringify(s) : '');"
        ),
        120,
    )
    after = json.loads(
        m.js("return Services.astraHost.Blocker.lists().then(v => JSON.stringify(v));")
    )
    report["engine"]["after_refresh"] = {
        "enabled_lists": sum(1 for x in after.get("lists", []) if x.get("enabled")),
        "installed_rules": after.get("installed_rules"),
        "last_update_unix": after.get("last_update_unix"),
        "status": json.loads(status) if status else None,
    }
    check(
        "all default lists installed",
        after.get("installed_rules", 0) > 120000,
        str(after.get("installed_rules")),
    )

    # --- turtlecute 128-host benchmark -----------------------------------
    navigate(m, TURTLECUTE)
    time.sleep(2)
    m.content()
    ready = wait(
        lambda: m.js(
            "const r=document.querySelector('#adb_test_r');"
            "const t=r?r.innerText:'';"
            "return (t.includes('blocked') && !t.includes('Total : 0')) ? t : '';"
        ),
        180,
    )
    report["turtlecute"]["summary"] = ready
    report["turtlecute"]["liquid_percent"] = m.js(
        "return getComputedStyle(document.body).getPropertyValue('--liquid-title');"
    )
    # localStorage carries the per-host matrix the page built.
    hosts = m.js(
        "try { const r=JSON.parse(localStorage.getItem('results')||'[]');"
        "const last=r[r.length-1]; return JSON.stringify(last?.abt?.hosts||{}); } catch(e) { return '{}'; }"
    )
    try:
        matrix = json.loads(hosts)
    except Exception:
        matrix = {}
    failed = []
    for group, entries in matrix.items():
        for name, values in entries.items():
            for host, blocked in values.items():
                if blocked is False:
                    failed.append(f"{group}/{name}/{host}")
    lines = m.js(
        "const t=document.querySelector('#test_log'); return t ? t.innerHTML : '';"
    )
    import re
    not_blocked = sorted(set(re.findall(r"([A-Za-z0-9._-]+) - not blocked", lines or "")))
    report["turtlecute"]["storage"] = m.js(
        "try { return JSON.stringify(Object.keys(localStorage)); } catch(e) { return '[]'; }"
    )
    cosmetic = m.js(
        "return JSON.stringify({"
        "static: !!document.querySelector('#cts_test') && document.querySelector('#cts_test').offsetHeight > 0,"
        "dynamic: !!document.querySelector('#ad_ctd') && document.querySelector('#ad_ctd').offsetHeight > 0,"
        "scriptAds: typeof s_test_ads !== 'undefined',"
        "scriptPagead: typeof s_test_pagead !== 'undefined'"
        "});"
    )
    report["turtlecute"]["failed_hosts"] = failed
    report["turtlecute"]["not_blocked_lines"] = not_blocked
    report["turtlecute"]["not_blocked_count"] = len(not_blocked)
    report["turtlecute"]["cosmetic"] = json.loads(cosmetic)
    report["turtlecute"]["shot"] = m.shot("turtlecute.png")
    m.content()
    m.shot("turtlecute-content.png")

    summary = ready or ""
    blocked = 0
    total = 0
    import re
    for line in summary.splitlines():
        line = line.strip()
        match = re.match(r"^Total\s*:\s*(\d+)$", line)
        if match:
            total = int(match.group(1))
            continue
        match = re.match(r"^(\d+)\s+blocked$", line)
        if match:
            blocked = int(match.group(1))
    report["turtlecute"]["total"] = total
    report["turtlecute"]["blocked"] = blocked
    percent = 100.0 if total == 0 else round(100.0 * blocked / total, 1)
    report["turtlecute"]["percent"] = percent
    check("turtlecute benchmark parsed", total > 0, summary[:200])
    check("turtlecute 100% blocked", blocked == total and total > 0, f"{blocked}/{total}")

    # --- YouTube pre-roll ------------------------------------------------
    m.chrome()
    navigate(m, YOUTUBE)
    time.sleep(6)
    m.content()
    m.js(
        "const v=document.querySelector('video');"
        "if(v){v.muted=true; const p=v.play(); if(p&&p.catch) p.catch(()=>{});}"
        "return true;"
    )
    time.sleep(2)
    m.js(
        "const v=document.querySelector('video');"
        "if(v && v.currentTime < 0.5){ const p=v.play(); if(p&&p.catch) p.catch(()=>{}); }"
        "return true;"
    )
    samples = []
    placements = 0
    for _ in range(24):
        raw = m.js(
            "const p=document.querySelector('#movie_player');"
            "const v=document.querySelector('video');"
            "const adEl=document.querySelector('.video-ads, .ytp-ad-module, .ytp-ad-overlay-container');"
            "const pr=window.ytInitialPlayerResponse||{};"
            "return JSON.stringify({"
            "  adShowing: !!p && p.classList.contains('ad-showing'),"
            "  adModuleVisible: !!adEl && adEl.offsetHeight > 0,"
            "  videoTime: v ? v.currentTime : -1,"
            "  duration: v ? v.duration : -1,"
            "  title: document.title,"
            "  ready: !!p,"
            "  adPlacements: Array.isArray(pr.adPlacements) ? pr.adPlacements.length : 0,"
            "  playerAds: Array.isArray(pr.playerAds) ? pr.playerAds.length : 0"
            "});"
        )
        state = json.loads(raw)
        placements = max(placements, state.get("adPlacements", 0), state.get("playerAds", 0))
        samples.append(state)
        time.sleep(1)
    report["youtube"]["samples"] = samples
    report["youtube"]["ad_placements"] = placements
    report["youtube"]["state"] = samples[-1] if samples else {}
    m.chrome()
    report["youtube"]["shot"] = m.shot("youtube.png")
    check("YouTube player reached a video", report["youtube"]["state"].get("ready") is True, str(samples[:1])[:200])
    check(
        "YouTube never showed an ad",
        all(sample.get("adShowing") is False for sample in samples),
        str([s for s in samples if s.get("adShowing")])[:300],
    )
    check(
        "YouTube video played while ads were present",
        any(sample.get("videoTime", 0) > 1 for sample in samples),
        str([s.get("videoTime") for s in samples])[:200],
    )
    check(
        "YouTube ad module stayed hidden",
        all(sample.get("adModuleVisible") is False for sample in samples),
        str([s for s in samples if s.get("adModuleVisible")])[:200],
    )

    # A real ad endpoint must be cancelled, while a normal YouTube asset loads.
    m.content()
    endpoint = m.js(
        "return new Promise(resolve => {"
        " const img=new Image();"
        " const timer=setTimeout(()=>resolve('timeout'), 8000);"
        " img.onload=()=>{clearTimeout(timer);resolve('loaded');};"
        " img.onerror=()=>{clearTimeout(timer);resolve('blocked');};"
        " img.src='https://googleads.g.doubleclick.net/pagead/id';"
        "});"
    )
    control = m.js(
        "return new Promise(resolve => {"
        " const img=new Image();"
        " const timer=setTimeout(()=>resolve('timeout'), 8000);"
        " img.onload=()=>{clearTimeout(timer);resolve('loaded');};"
        " img.onerror=()=>{clearTimeout(timer);resolve('blocked');};"
        " img.src='https://www.youtube.com/favicon.ico';"
        "});"
    )
    report["youtube"]["ad_endpoint"] = endpoint
    report["youtube"]["control_asset"] = control
    m.chrome()
    check("YouTube ad endpoint is blocked", endpoint == "blocked", endpoint)
    check("YouTube normal asset still loads", control == "loaded", control)

    report["engine"]["final_stats"] = json.loads(
        m.js(
            "const s=Cc['@astra/blocker;1'].getService(Ci.nsIAstraBlockerService); return s.stats();"
        )
    )
    with open(os.path.join(OUT, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print("REPORT", json.dumps(report, indent=2)[:4000])
finally:
    try:
        proc.terminate()
        proc.wait(timeout=15)
    except Exception:
        proc.kill()
    log.close()

print("adblock benchmark:", "PASS" if not failures else "FAIL: " + ", ".join(failures))
sys.exit(0 if not failures else 1)
