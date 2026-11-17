#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Real-site tab stress probe: 50 cold tabs, video playing, resources measured.

Run against any built Astra binary (Windows or Linux):

    python3 tools/perf/stress/web_tabs_probe.py
    python3 tools/perf/stress/web_tabs_probe.py --tabs 20 --steady 30
    ASTRA_BINARY=/path/to/firefox python3 tools/perf/stress/web_tabs_probe.py

What it does, in order:

1. Launches the build with a **fresh profile** (cold cache) on Marionette.
2. Creates `--tabs` real pages through the Host API (`Tabs.create`), a mix of
   news, video (YouTube/Vimeo/direct 1080p) and heavy web apps, one URL per
   site so nothing is served from cache.
3. Walks every tab once. Astra's background tabs are lazy (`Content.sys.mjs`
   `pending`), so creating 50 tabs alone loads nothing; activation is what
   makes each page load, and that is the load a person actually pays. The cold
   `activate_ms` series includes the walk dwell; a `REWALK` pass over tabs the
   browser has already discarded measures warm wake and restore latency after
   the dwell.
4. Mutates nothing else apart from the run's own controls: video tabs are
   muted through `Tabs.setMuted`, `--pause-video` also pauses them, and
   `--idle-hold` leaves the window untouched so the sleeping driver can
   discard tabs, then audits every tab (discarded / audible / warm / other).
   The window stays headed, and the platform sampler records the browser
   process tree only (never a pre-existing Firefox on the machine).

Phases written to `<out>/result.json` and sliced in `REPORT.md`:
`baseline` (one blank tab), `open+walk` (cold loading), `steady` (all tabs
loaded, video playing), `idle_hold` (with `--idle-hold`: no interaction,
discarded/awake counts on every sample row), `video` (background-decode
suspension off, players re-walked), `closed` (reclaim curve after closing every
tab, for `--close-wait` seconds).

Platform notes:

- Windows: PowerShell sampler reads `Win32_PerfFormattedData_*` (per-process
  CPU / working set / private bytes / handles / threads), GPU engine and video
  decode counters, GPU process memory, network and commit charge.
- Linux: `/proc` walk of the launched tree (cpu jiffies, VmRSS, private via
  `smaps_rollup`) plus `/proc/net/dev`. GPU columns stay null here; the
  loopback matrix harness (`run_matrix.py`) owns GPU attribution on Linux.

Exit codes: 0 PASS, 1 FAIL, 2 SKIP (no built binary). Stdlib only.
"""
import argparse
import base64
import functools
import hashlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
IS_WIN = os.name == "nt"
OBJ = "obj-astra-windows" if IS_WIN else "obj-astra-linux"
EXE = "firefox.exe" if IS_WIN else "firefox"
FIXTURES = os.path.join(HERE, "fixtures")

# One URL per site so a cold profile really stays cold. News, video, apps.
URLS = [
    "https://www.bbc.com/news",
    "https://www.cnn.com/",
    "https://www.nytimes.com/",
    "https://www.theguardian.com/international",
    "https://apnews.com/",
    "https://www.reuters.com/",
    "https://www.npr.org/",
    "https://www.aljazeera.com/",
    "https://www.washingtonpost.com/",
    "https://www.lemonde.fr/",
    "https://www.spiegel.de/",
    "https://www.cbc.ca/news",
    "https://www.abc.net.au/news",
    "https://www.scmp.com/",
    "https://www.economist.com/",
    "https://arstechnica.com/",
    "https://www.theverge.com/",
    "https://www.wired.com/",
    # YouTube embeds answer "Error 153" (missing referer) as a top-level tab;
    # watch pages play. All of them are muted after load.
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=9bZkp7q19f0",
    "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
    "https://www.youtube.com/watch?v=OPf0YbXqDm0",
    "https://www.youtube.com/watch?v=JGwWNGJdvx8",
    "https://www.youtube.com/watch?v=RgKAFK5djSk",
    "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
    "https://www.youtube.com/watch?v=CevxZvSJLk8",
    "https://www.youtube.com/watch?v=hT_nvWreIhg",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    "https://vimeo.com/76979871",
    "https://player.vimeo.com/video/148751763?autoplay=1&muted=1",
    "https://media.w3.org/2010/05/sintel/trailer.mp4",
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    "https://download.blender.org/peach/trailer/trailer_480p.mov",
    "https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_5MB.mp4",
    "https://www.reddit.com/",
    "https://github.com/explore",
    "https://www.amazon.com/",
    "https://www.google.com/maps",
    "https://www.spotify.com/us/",
    "https://discord.com/",
    "https://stackoverflow.com/questions",
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://imgur.com/",
    "https://9gag.com/",
    "https://www.instagram.com/",
    "https://www.tiktok.com/",
    "https://www.netflix.com/browse",
    "https://www.booking.com/",
    "https://www.ebay.com/",
]

VIDEO_HINTS = ("youtube.com/watch", "vimeo", ".mp4", ".mov", "test-videos", "blender", "gtv-videos")

PREFS = {
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.page": 0,
    "browser.startup.homepage": "about:blank",
    "browser.aboutwelcome.enabled": False,
    "browser.newtabpage.enabled": False,
    "browser.sessionstore.resume_from_crash": False,
    "browser.tabs.warnOnClose": False,
    "datareporting.healthreport.uploadEnabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "app.shield.optoutstudies.enabled": False,
    "media.autoplay.default": 0,
    "media.autoplay.blocking_policy": 0,
    "media.block-autoplay-until-in-foreground": False,
    # No speaker output while 17 players start; per-tab mute is applied too.
    "media.volume_scale": 0.0,
}

# --- Marionette -------------------------------------------------------------


class Marionette:
    """Minimal stdlib client (the same protocol tests/contract/load_state.py uses)."""

    def __init__(self, port, timeout=120):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
                break
            except OSError as exc:  # pragma: no cover - boot race
                last = exc
                time.sleep(0.2)
        else:
            raise RuntimeError(f"marionette never came up: {last}")
        self.sock.settimeout(900)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            rest += self.f.read(length - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:600]}")
                return msg[3]

    def execute(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def execute_async(self, script, args=None):
        return self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})["value"]

    def chrome(self, script, args=None):
        self.cmd("Marionette:SetContext", {"value": "chrome"})
        try:
            return self.execute(script, args)
        finally:
            self.cmd("Marionette:SetContext", {"value": "content"})

    def chrome_async(self, script, args=None, timeout_ms=300000):
        self.cmd("Marionette:SetContext", {"value": "chrome"})
        self.cmd("WebDriver:SetTimeouts", {"script": timeout_ms, "implicit": 0, "pageLoad": 180000})
        try:
            return self.execute_async(script, args)
        finally:
            self.cmd("Marionette:SetContext", {"value": "content"})


# --- scripts (chrome context unless noted) ----------------------------------

OPEN = """
const done = arguments[arguments.length - 1];
(async () => {
  const urls = arguments[0];
  let host = null;
  for (let i = 0; i < 120; i++) {
    host = Services.astraHost;
    if (host?.Tabs) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!host?.Tabs) { done(JSON.stringify({ error: "no Tabs host" })); return; }
  const out = [];
  const t0 = performance.now();
  for (const url of urls) {
    const a = performance.now();
    try {
      const r = await host.Tabs.create({ request_id: `web-${out.length}`, url, background: true });
      out.push({ url, id: r.astra_tab_id, ms: Math.round(performance.now() - a) });
    } catch (e) {
      out.push({ url, error: String((e && e.message) || e) });
    }
  }
  done(JSON.stringify({ tabs: out, total_ms: Math.round(performance.now() - t0) }));
})()
"""

LOADED_NOW = """
return JSON.stringify([...gBrowser.tabs].map((t) => {
  const b = t.linkedBrowser;
  return { id: t.getAttribute('astra-tab-id'), uri: (b.currentURI || {}).spec || "" };
}))
"""

WALK = """
const done = arguments[arguments.length - 1];
(async () => {
  const ids = arguments[0];
  const dwell = arguments[1];
  const out = [];
  for (const id of ids) {
    const tab = [...gBrowser.tabs].find((t) => t.getAttribute('astra-tab-id') === id);
    if (!tab) { out.push({ id, missing: true }); continue; }
    const a = performance.now();
    gBrowser.selectedTab = tab;
    await new Promise((r) => setTimeout(r, dwell));
    out.push({ id, activate_ms: Math.round(performance.now() - a),
               uri: (tab.linkedBrowser.currentURI || {}).spec || "" });
  }
  done(JSON.stringify(out));
})()
"""

TAB_COUNTS = """
return JSON.stringify((() => {
  const tabs = [...gBrowser.tabs];
  const discarded = tabs.filter((t) => t.hasAttribute('discarded'));
  return { total: tabs.length, discarded: discarded.length,
           discarded_ids: discarded.map((t) => t.getAttribute('astra-tab-id')),
           awake: tabs.length - discarded.length };
})())
"""

DISCARD_AUDIT = """
return JSON.stringify([...gBrowser.tabs].map((t, i) => {
  const b = t.linkedBrowser;
  let url = "";
  try { url = (b.currentURI || {}).spec || ""; } catch (e) {}
  return { index: i, id: t.getAttribute('astra-tab-id') || "", url,
           selected: t.selected === true, discarded: t.hasAttribute('discarded'),
           soundplaying: t.hasAttribute('soundplaying'), muted: t.hasAttribute('muted') };
}))
"""

REWALK = """
const done = arguments[arguments.length - 1];
(async () => {
  const ids = arguments[0];
  const dwell = arguments[1];
  const out = [];
  for (const id of ids) {
    const tab = [...gBrowser.tabs].find((t) => t.getAttribute('astra-tab-id') === id);
    if (!tab) { out.push({ id, missing: true }); continue; }
    if (!tab.hasAttribute('discarded')) { out.push({ id, skipped: 'not-discarded' }); continue; }
    gBrowser.selectedTab = tab;
    await new Promise((r) => setTimeout(r, dwell));
    const a = performance.now();
    while (tab.hasAttribute('discarded') && performance.now() - a < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const wake = performance.now() - a;
    while (performance.now() - a < 20000) {
      let loading = false;
      const b = tab.linkedBrowser;
      try { loading = b.webProgress ? b.webProgress.isLoadingDocument === true : false; } catch (e) {}
      if (!loading && !tab.hasAttribute('discarded')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const total = performance.now() - a;
    const restored = !tab.hasAttribute('discarded');
    let loading = false;
    try {
      const b = tab.linkedBrowser;
      loading = b.webProgress ? b.webProgress.isLoadingDocument === true : false;
    } catch (e) {}
    out.push({ id, restored, loading, warm_wake_ms: Math.round(wake),
               warm_load_ms: Math.round(total - wake),
               warm_activate_ms: restored && !loading ? Math.round(total) : null });
  }
  done(JSON.stringify(out));
})()
"""

LOAD_POLL = """
const done = arguments[arguments.length - 1];
(async () => {
  const budget = arguments[0];
  const t0 = Date.now();
  const res = [];
  while (Date.now() - t0 < budget) {
    await new Promise((r) => setTimeout(r, 1500));
    const rows = [...gBrowser.tabs].map((t) => {
      let loading = null, title = "";
      try {
        const b = t.linkedBrowser;
        loading = b.webProgress ? b.webProgress.isLoadingDocument : null;
        title = b.contentTitle || "";
      } catch (e) {}
      return { loading, title };
    });
    const loading = rows.filter((r) => r.loading).length;
    const untitled = rows.filter((r) => r.title === "").length;
    res.push({ t: Date.now() - t0, n: rows.length, loading, titled: rows.length - untitled });
    // One blank tab plus at most one page that never reports a title (a
    // direct video document) is a finished load, not a pending one.
    if (rows.length > 0 && loading === 0 && untitled <= 2 && Date.now() - t0 > 8000) break;
  }
  done(JSON.stringify(res));
})()
"""

PAUSE_VIDEO = """
const done = arguments[arguments.length - 1];
(async () => {
  const ids = arguments[0];
  const out = [];
  for (const id of ids) {
    const tab = [...gBrowser.tabs].find((t) => t.getAttribute('astra-tab-id') === id);
    if (!tab) { out.push({ id, missing: true }); continue; }
    const b = tab.linkedBrowser;
    let ctrl = null;
    try { ctrl = b.browsingContext ? b.browsingContext.mediaController : null; } catch (e) { ctrl = null; }
    if (!ctrl) { out.push({ id, active: false, paused: null }); continue; }
    let active = false, playing = false;
    try { active = ctrl.isActive === true; playing = ctrl.isPlaying === true; } catch (e) {}
    let paused = false;
    try { ctrl.pause(); paused = ctrl.isPlaying === false; } catch (e) {}
    out.push({ id, active, was_playing: playing, paused, muted: b.audioMuted === true });
  }
  done(JSON.stringify(out));
})()
"""

MUTE = """
const done = arguments[arguments.length - 1];
(async () => {
  const ids = arguments[0];
  const out = [];
  for (const id of ids) {
    try {
      await Services.astraHost.Tabs.setMuted({ request_id: 'web-mute', astra_tab_id: id, muted: true });
    } catch (e) { out.push({ id, error: String(e) }); continue; }
    const t = [...gBrowser.tabs].find((x) => x.getAttribute('astra-tab-id') === id);
    out.push({ id, muted: t ? t.linkedBrowser.audioMuted === true : null });
  }
  done(JSON.stringify(out));
})()
"""

CHROME_FRAMES = """
const done = arguments[arguments.length - 1];
(async () => {
  const frames = [];
  const start = performance.now();
  await new Promise((res) => {
    let last = performance.now();
    const tick = (ts) => {
      frames.push(Math.round(ts - last));
      last = ts;
      if (performance.now() - start < arguments[0]) requestAnimationFrame(tick);
      else res();
    };
    requestAnimationFrame(tick);
  });
  done(JSON.stringify(frames));
})()
"""

SWITCH = """
const done = arguments[arguments.length - 1];
(async () => {
  const tabs = [...gBrowser.tabs];
  const step = Math.max(1, Math.floor(tabs.length / 10));
  const picks = [];
  for (let i = 0; i < tabs.length && picks.length < 10; i += step) picks.push(tabs[i]);
  const out = [];
  for (const t of picks) {
    const a = performance.now();
    gBrowser.selectedTab = t;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.push(Math.round(performance.now() - a));
  }
  done(JSON.stringify(out));
})()
"""

TAB_PIDS = """
const done = arguments[arguments.length - 1];
(async () => {
  const out = [];
  for (const t of gBrowser.tabs) {
    let pid = null;
    try { pid = t.linkedBrowser.browsingContext.currentWindowGlobal.domProcess.osPid; } catch (e) { pid = null; }
    out.push({ id: t.getAttribute('astra-tab-id'), pid, url: (t.linkedBrowser.currentURI || {}).spec || "" });
  }
  done(JSON.stringify(out));
})()
"""

TAB_STATE = """
return JSON.stringify([...gBrowser.tabs].map((t) => {
  const b = t.linkedBrowser;
  return { id: t.getAttribute('astra-tab-id'), label: t.label,
           url: (b.currentURI || {}).spec || '', muted: b.audioMuted === true,
           discarded: t.hasAttribute('discarded'), title: b.contentTitle || '' };
}))
"""

MEDIA_VIEW = """return JSON.stringify((() => {
  try { return Services.astraHost.Media.view(); } catch (e) { return { error: String(e) }; }
})())"""

CLOSE_ALL = """
const done = arguments[arguments.length - 1];
(async () => {
  const blank = gBrowser.addTab("about:blank", {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    skipAnimation: true,
  });
  gBrowser.selectedTab = blank;
  gBrowser.removeAllTabsBut(blank);
  await new Promise((r) => setTimeout(r, 500));
  done(JSON.stringify({ tabs: gBrowser.tabs.length }));
})()
"""

STAGE_SELECT = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (gBrowser.tabs.length === 0) { done(JSON.stringify({ ok: false, reason: "no awake tab" })); return; }
  let tab = gBrowser.tabs[0];
  let fallback = false;
  gBrowser.selectedTab = tab;
  for (let i = 0; i < 100 && tab.hasAttribute('discarded'); i++) await wait(100);
  if (tab.hasAttribute('discarded')) {
    tab = [...gBrowser.tabs].find((t) => !t.hasAttribute('discarded')) || null;
    if (!tab) { done(JSON.stringify({ ok: false, reason: "no awake tab" })); return; }
    fallback = true;
    gBrowser.selectedTab = tab;
    await wait(300);
  }
  done(JSON.stringify({ ok: true, fallback, index: [...gBrowser.tabs].indexOf(tab),
                        id: tab.getAttribute('astra-tab-id') || "" }));
})()
"""

STAGE_LOAD = """
const url = arguments[0];
gBrowser.selectedBrowser.fixupAndLoadURIString(url, {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
});
return 'ok'
"""

STAGE_VIDEO = """
const done = arguments[arguments.length - 1];
(async () => {
  const v = document.querySelector('video');
  const q0 = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const t0 = v ? v.currentTime : 0;
  const frames = [];
  const start = performance.now();
  await new Promise((res) => {
    let last = performance.now();
    const tick = (ts) => {
      frames.push(Math.round(ts - last));
      last = ts;
      if (performance.now() - start < arguments[0]) requestAnimationFrame(tick);
      else res();
    };
    requestAnimationFrame(tick);
  });
  const elapsed = (performance.now() - start) / 1000;
  const info = { visibility: document.visibilityState, url: location.href,
                 fps: Math.round(frames.length / elapsed * 10) / 10 };
  if (v) {
    const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    info.video = {
      paused: v.paused, muted: v.muted, ready: v.readyState, w: v.videoWidth, h: v.videoHeight,
      advanced_s: Math.round((v.currentTime - t0) * 100) / 100,
      decoded_frames: q1 ? q1.totalVideoFrames - q0.totalVideoFrames : null,
      dropped_frames: q1 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null,
    };
  }
  info.frames = frames;
  done(JSON.stringify(info));
})()
"""

# --- platform samplers ------------------------------------------------------

PS_SAMPLER = r"""
param([string]$Binary, [string]$OutFile, [int]$IntervalMs, [string]$StopFile)
$ErrorActionPreference = 'SilentlyContinue'
$psi = New-Object System.IO.StreamWriter($OutFile, $false)
$psi.AutoFlush = $true
$tick = 0; $lastSnap = @{}; $lastT = $null

function Get-GpuSnapshot($pids) {
    $eng = @{ '3d' = 0.0; 'videodecode' = 0.0; 'videoprocess' = 0.0; 'copy' = 0.0; 'other' = 0.0 }
    $total = 0.0
    foreach ($s in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)) {
        if ($s.UtilizationPercentage -le 0) { continue }
        if ($s.Name -notmatch '^pid_(\d+)') { continue }
        if ($pids -notcontains [int]$Matches[1]) { continue }
        if ($s.Name -match 'engtype_(\w+)') {
            $t = $Matches[1].ToLower()
            if ($eng.ContainsKey($t)) { $eng[$t] += $s.UtilizationPercentage } else { $eng['other'] += $s.UtilizationPercentage }
            $total += $s.UtilizationPercentage
        }
    }
    $mem = 0.0
    foreach ($s in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory)) {
        if ($s.Name -match '^pid_(\d+)') {
            if ($pids -contains [int]$Matches[1]) { $mem += [double]$s.LocalUsage }
        }
    }
    return @{ total = [math]::Round($total, 1); engines = $eng; mem_mb = [math]::Round($mem / 1MB, 1) }
}

while (-not (Test-Path $StopFile)) {
    $t0 = Get-Date
    $ts = ([DateTimeOffset]$t0.ToUniversalTime()).ToUnixTimeMilliseconds()
    $snap = @{}; $pids = @()
    foreach ($p in (Get-Process | Where-Object { $_.ProcessName -eq 'firefox' })) {
        if ($p.Path -eq $Binary) { $pids += $p.Id; $snap[[string]$p.Id] = [double]$p.CPU }
    }
    if ($lastT -ne $null) { $dt = ($t0 - $lastT).TotalSeconds } else { $dt = 0.0 }
    if ($dt -le 0.1) { $dt = 0.0 }
    $pidSet = @{}
    foreach ($p in $pids) { $pidSet[[string]$p] = $true }
    $astra = @(); $ws = 0.0; $priv = 0.0; $sum = 0.0; $max = 0.0; $thr = 0; $hd = 0
    foreach ($pp in (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)) {
        if ($pp.Name -eq '_Total' -or $pp.Name -eq 'Idle') { continue }
        if (-not $pidSet.ContainsKey([string]$pp.IDProcess)) { continue }
        $cpu = 0.0
        if ($dt -gt 0 -and $lastSnap.ContainsKey([string]$pp.IDProcess) -and $snap.ContainsKey([string]$pp.IDProcess)) {
            $d = $snap[[string]$pp.IDProcess] - $lastSnap[[string]$pp.IDProcess]
            if ($d -gt 0) { $cpu = $d / $dt }
        }
        $w = [double]$pp.WorkingSet / 1MB; $pv = [double]$pp.WorkingSetPrivate / 1MB
        $astra += [ordered]@{ pid = [int]$pp.IDProcess; cpu = [math]::Round($cpu, 2);
            ws_mb = [math]::Round($w, 1); priv_mb = [math]::Round($pv, 1);
            threads = [int]$pp.ThreadCount; handles = [int]$pp.HandleCount }
        $ws += $w; $priv += $pv; $sum += $cpu; $thr += [int]$pp.ThreadCount; $hd += [int]$pp.HandleCount
        if ($cpu -gt $max) { $max = $cpu }
    }
    $cpuTotal = 0.0; $cores = @()
    foreach ($c in (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor)) {
        if ($c.Name -eq '_Total') { $cpuTotal = [double]$c.PercentProcessorTime } else { $cores += [double]$c.PercentProcessorTime }
    }
    $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $net = 0.0
    if (($tick % 3) -eq 0) {
        foreach ($n in (Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)) {
            if ($n.Name -notmatch 'Loopback|isatap|Teredo') { $net += [double]$n.BytesTotalPersec }
        }
    }
    $gpu = Get-GpuSnapshot $pids
    $tick++
    $row = [ordered]@{ ts = $ts; cpu_total = [math]::Round($cpuTotal, 1); cpu_cores = $cores
        mem_avail = [double]$mem.AvailableMBytes; mem_commit = [math]::Round([double]$mem.CommittedBytes / 1MB, 1)
        net_kbps = [math]::Round($net / 1024, 1); procs = $astra.Count
        ws_mb = [math]::Round($ws, 1); priv_mb = [math]::Round($priv, 1)
        cpu_proc = [math]::Round($sum, 2); cpu_max = [math]::Round($max, 2)
        threads = $thr; handles = $hd; gpu = $gpu; proc = $astra }
    $psi.WriteLine(($row | ConvertTo-Json -Depth 5 -Compress))
    $lastSnap = $snap; $lastT = $t0
    $elapsed = ((Get-Date) - $t0).TotalMilliseconds
    $sleep = $IntervalMs - $elapsed
    if ($sleep -gt 30) { Start-Sleep -Milliseconds ([int]$sleep) }
}
$psi.Close()
"""


class WindowsSampler:
    """PowerShell sampler; one row per interval, browser tree only."""

    def __init__(self, binary, outdir, interval_ms=2500):
        self.binary = binary
        self.outdir = outdir
        self.interval_ms = interval_ms
        self.samples = os.path.join(outdir, "samples.jsonl")
        self.stopfile = os.path.join(outdir, "stop.signal")
        self.script = os.path.join(outdir, "sampler.ps1")
        self.proc = None
        self.root_pid = None

    def start(self):
        with open(self.script, "w", encoding="utf-8") as fh:
            fh.write(PS_SAMPLER)
        for path in (self.samples, self.stopfile):
            if os.path.exists(path):
                os.remove(path)
        self.proc = subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", self.script,
             "-Binary", self.binary, "-OutFile", self.samples,
             "-IntervalMs", str(self.interval_ms), "-StopFile", self.stopfile],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop(self):
        open(self.stopfile, "w").close()
        try:
            self.proc.wait(timeout=20)
        except Exception:  # noqa: BLE001 - sampler already gone
            self.proc.kill()

    def rows(self):
        out = []
        try:
            with open(self.samples, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        except FileNotFoundError:
            pass
        return out

    def reap(self):
        """Kill every process of this build (never another Firefox on the box)."""
        env = dict(os.environ, ASTRA_BIN=self.binary)
        ps = ('$b=$env:ASTRA_BIN; Get-CimInstance Win32_Process -Filter "Name=\'firefox.exe\'" | '
              'Where-Object { $_.ExecutablePath -eq $b } | '
              'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }')
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                                 capture_output=True, text=True, env=env, timeout=120).stdout
        except Exception:  # noqa: BLE001
            return []
        return [int(x) for x in out.split() if x.strip().isdigit()]


class LinuxSampler:
    """`/proc` walk of the launched tree; the matrix harness owns GPU there."""

    HZ = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100

    def __init__(self, binary, outdir, interval_ms=2500):
        self.binary = binary
        self.outdir = outdir
        self.interval_ms = interval_ms
        self.samples = os.path.join(outdir, "samples.jsonl")
        self.stopfile = os.path.join(outdir, "stop.signal")
        self.thread = None
        self._stop = threading.Event()
        self.root_pid = None

    def start(self):
        open(self.samples, "w", encoding="utf-8").close()
        self._stop.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()
        if self.thread:
            self.thread.join(timeout=30)

    def _pids(self):
        root = self.root_pid
        if root is None:
            return []
        children = {}
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat", "rb") as fh:
                    fields = fh.read().rsplit(b")", 1)[1].split()
                children.setdefault(int(fields[1]), []).append(int(entry))
            except OSError:
                continue
        out, todo = [], [root]
        while todo:
            pid = todo.pop()
            out.append(pid)
            todo.extend(children.get(pid, []))
        return out

    def _stat(self, pid):
        with open(f"/proc/{pid}/stat", "rb") as fh:
            fields = fh.read().rsplit(b")", 1)[1].split()
        return int(fields[11]) + int(fields[12])  # utime + stime

    def _mem(self, pid):
        rss = priv = 0.0
        try:
            with open(f"/proc/{pid}/status") as fh:
                for line in fh:
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1]) / 1024
                        break
        except OSError:
            pass
        try:
            with open(f"/proc/{pid}/smaps_rollup") as fh:
                private = 0
                for line in fh:
                    if line.startswith(("Private_Clean:", "Private_Dirty:")):
                        private += int(line.split()[1])
                priv = private / 1024
        except OSError:
            priv = rss
        return rss, priv

    def _system(self):
        with open("/proc/stat") as fh:
            parts = [int(x) for x in fh.readline().split()[1:]]
        idle, total = parts[3] + parts[4], sum(parts)
        with open("/proc/meminfo") as fh:
            mem = {}
            for line in fh:
                key, value = line.split(":", 1)
                mem[key] = int(value.split()[0])
        net = 0
        with open("/proc/net/dev") as fh:
            for line in fh.readlines()[2:]:
                name, data = line.split(":", 1)
                if name.strip() == "lo":
                    continue
                net += sum(int(x) for x in data.split()[:8])
        return idle, total, mem.get("MemAvailable", 0) / 1024, mem.get("Committed_AS", 0) / 1024, net

    def _loop(self):
        last_cpu, last_t, last_sys, last_net = {}, None, None, None
        while not self._stop.is_set():
            now = time.time()
            pids = self._pids()
            cpu = {}
            procs = []
            for pid in pids:
                try:
                    ticks = self._stat(pid)
                except OSError:
                    continue
                cpu[pid] = ticks
                rss, priv = self._mem(pid)
                delta = ticks - last_cpu.get(pid, ticks)
                cores = 0.0
                if last_t is not None and now > last_t:
                    cores = (delta / self.HZ) / (now - last_t)
                procs.append({"pid": pid, "cpu": round(cores, 2), "ws_mb": round(rss, 1),
                              "priv_mb": round(priv, 1)})
            idle, total, avail, commit, net = self._system()
            sys_cpu = 0.0
            net_kbps = 0.0
            if last_sys is not None:
                di, dt = idle - last_sys[0], total - last_sys[1]
                if dt > 0:
                    sys_cpu = round(100.0 * (1 - di / dt), 1)
                if last_net is not None and now > last_t:
                    net_kbps = round((net - last_net) / 1024.0 / (now - last_t), 1)
            row = {
                "ts": int(now * 1000), "cpu_total": sys_cpu,
                "cpu_cores": [round(sys_cpu / 100.0 * (os.cpu_count() or 1), 2)],
                "mem_avail": round(avail, 1), "mem_commit": round(commit, 1), "net_kbps": net_kbps,
                "procs": len(procs), "ws_mb": round(sum(p["ws_mb"] for p in procs), 1),
                "priv_mb": round(sum(p["priv_mb"] for p in procs), 1),
                "cpu_proc": round(sum(p["cpu"] for p in procs), 2),
                "cpu_max": round(max([p["cpu"] for p in procs] or [0]), 2),
                "threads": None, "handles": None,
                "gpu": None, "proc": procs,
            }
            with open(self.samples, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row) + "\n")
            last_cpu, last_t, last_sys, last_net = cpu, now, (idle, total), net
            self._stop.wait(self.interval_ms / 1000.0)

    def rows(self):
        out = []
        try:
            with open(self.samples, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        try:
                            out.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        except FileNotFoundError:
            pass
        return out

    def reap(self):
        """SIGTERM the launched tree (children die with the parent on Linux)."""
        if not self.root_pid:
            return []
        killed = []
        for pid in self._pids():
            try:
                os.kill(pid, 15)
                killed.append(pid)
            except OSError:
                pass
        return killed


def sample_backend(binary, outdir):
    return WindowsSampler(binary, outdir) if IS_WIN else LinuxSampler(binary, outdir)


# --- run --------------------------------------------------------------------


def resolve_binary():
    env = os.environ.get("ASTRA_BINARY")
    if env:
        return env if os.path.exists(env) else None
    cand = os.path.join(ROOT, "engine", OBJ, "dist", "bin", EXE)
    if os.path.exists(cand):
        return cand
    return shutil.which("firefox")


def launch(binary, profile, port):
    os.makedirs(profile, exist_ok=True)
    prefs = dict(PREFS, **{"marionette.port": port})
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        for key, value in prefs.items():
            fh.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")
    log = open(os.path.join(profile, "browser.log"), "wb")
    proc = subprocess.Popen(
        [binary, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(os.path.abspath(binary)),
        stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, MOZ_CRASHREPORTER_DISABLE="1"),
        start_new_session=not IS_WIN)
    return proc, log


def serve_fixtures():
    handler = functools.partial(_QuietHandler, directory=FIXTURES)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/video.html"


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def provenance(binary):
    def git(*argv):
        try:
            out = subprocess.run(["git", "-C", ROOT, *argv], capture_output=True,
                                 text=True, encoding="utf-8", errors="replace", timeout=20)
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:  # noqa: BLE001 - provenance is best effort
            return None

    def stat(path):
        try:
            st = os.stat(path)
            return {"mtime": round(st.st_mtime, 3), "size": st.st_size}
        except OSError:
            return None

    digest = hashlib.sha256()
    try:
        with open(os.path.abspath(__file__), "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        sha = digest.hexdigest()
    except OSError:
        sha = None
    status = git("status", "--porcelain")
    return {
        "git_head": git("rev-parse", "HEAD"),
        "git_status": status,
        "git_clean": (status == "") if status is not None else None,
        "binary": stat(binary),
        "probe": stat(os.path.abspath(__file__)),
        "probe_sha256": sha,
    }


def annotate_hold(rows, observations, phases):
    """Stamp each sampler row in the idle hold with its discarded/awake counts.

    The counts come from a chrome read at most 5 s old; the sampler itself is
    untouched.
    """
    start = phases.get("idle_hold")
    if not observations or not start:
        return 0
    end = phases.get("idle_hold_end") or start
    obs = sorted(observations, key=lambda o: o["ts"])
    stamped = 0
    for row in rows:
        ts = row["ts"] / 1000.0
        if not start <= ts <= end:
            continue
        pick = obs[0]
        for o in obs:
            if o["ts"] <= ts:
                pick = o
            else:
                break
        row["discarded_count"] = pick.get("discarded")
        row["awake_count"] = pick.get("awake")
        stamped += 1
    return stamped


def reclaim_curve(result, rows):
    ph = result.get("phases", {})
    close, end = ph.get("close"), ph.get("end")
    if not close:
        return None
    before = [r["priv_mb"] for r in rows
              if r["ts"] / 1000.0 < close and r.get("priv_mb") is not None]
    window = [r for r in rows
              if r.get("priv_mb") is not None and close <= r["ts"] / 1000.0 <= (end or close)]
    base = before[-1] if before else (window[0]["priv_mb"] if window else None)
    if base is None or not window:
        return None
    points = [{"t_s": round(r["ts"] / 1000.0 - close, 1), "ts": round(r["ts"] / 1000.0, 3),
               "priv_mb": r["priv_mb"],
               "pct_of_before": round(100.0 * r["priv_mb"] / base, 1)} for r in window]
    hit = next((p for p in points if p["pct_of_before"] <= 10.0), None)
    return {
        "before_priv_mb": base,
        "close_ts": round(close, 3),
        "wait_s": round((end or close) - close, 1),
        "points": points,
        "first_ts_under_10pct": hit["ts"] if hit else None,
        "first_s_under_10pct": hit["t_s"] if hit else None,
        "final_priv_mb": points[-1]["priv_mb"],
    }


def classify_audit(audit, walk):
    walked = [w.get("id") for w in walk if w.get("id")]
    # sleeping.rs DEFAULT_KEEP_WARM_COUNT: the six most recently active tabs
    # are never selected for sleep, and the selected tab is active.
    warm_ids = set(walked[-6:])
    warm_ids.update(row["id"] for row in audit if row.get("selected"))
    for row in audit:
        if row.get("discarded"):
            row["reason"] = "discarded"
        elif row.get("soundplaying"):
            row["reason"] = "audible"
        elif row.get("id") in warm_ids:
            row["reason"] = "warm"
        else:
            row["reason"] = "other"
    return {key: sum(1 for row in audit if row["reason"] == key)
            for key in ("discarded", "audible", "warm", "other")}


def summarize(result, rows, workers, root_pid=None):
    ph = result["phases"]

    def window(a, b):
        return [r for r in rows if ph[a] <= r["ts"] / 1000 < ph.get(b, 9e18)]

    def top(w, key, fn):
        vals = [r[key] for r in w if r.get(key) is not None]
        return fn(vals) if vals else 0

    out = {}
    windows = {
        "baseline": ("launch", "open"),
        "open+load": ("open", "loaded"),
        "steady": ("steady", "idle_hold" if "idle_hold" in ph else "video_phase"),
        "idle_hold": ("idle_hold", "idle_hold_end"),
        "video": ("video_phase", "video_phase_end"),
        "closed": ("close", "end"),
    }
    for name, (a, b) in windows.items():
        if a not in ph:
            continue
        w = window(a, b)
        if not w:
            continue
        gpu = [((r.get("gpu") or {}).get("total", 0)) for r in w]
        vdec = [((r.get("gpu") or {}).get("engines") or {}).get("videodecode", 0) for r in w]
        parent = [p["priv_mb"] for r in w for p in (r.get("proc") or [])
                  if root_pid is not None and p.get("pid") == root_pid
                  and p.get("priv_mb") is not None]
        discarded = [r["discarded_count"] for r in w if r.get("discarded_count") is not None]
        awake = [r["awake_count"] for r in w if r.get("awake_count") is not None]
        out[name] = {
            "samples": len(w), "seconds": round((w[-1]["ts"] - w[0]["ts"]) / 1000, 1),
            "priv_mb_med": round(top(w, "priv_mb", lambda v: sorted(v)[len(v) // 2]), 1),
            "priv_mb_max": round(top(w, "priv_mb", max), 1),
            "ws_mb_max": round(top(w, "ws_mb", max), 1),
            "mem_avail_min": round(top(w, "mem_avail", min), 1),
            "cpu_cores_med": round(top(w, "cpu_proc", lambda v: sorted(v)[len(v) // 2]), 2),
            "cpu_cores_max": round(top(w, "cpu_proc", max), 2),
            "cpu_pct_of_machine_max": round(100 * top(w, "cpu_proc", max) / workers, 1),
            "cpu_total_max": round(top(w, "cpu_total", max), 1),
            "gpu_max": round(max(gpu or [0]), 1),
            "video_decode_max": round(max(vdec or [0]), 1),
            "gpu_mem_mb": round(max(((r.get("gpu") or {}).get("mem_mb", 0)) for r in w), 1),
            "procs_max": top(w, "procs", max),
            "threads_max": top(w, "threads", max),
            "handles_max": top(w, "handles", max),
            "net_kbps_max": round(top(w, "net_kbps", max), 1),
        }
        if parent:
            out[name]["parent_priv_mb"] = round(sorted(parent)[len(parent) // 2], 1)
            out[name]["parent_priv_mb_max"] = round(max(parent), 1)
        if discarded:
            out[name]["discarded_count"] = discarded[-1]
            out[name]["awake_count"] = awake[-1]
            out[name]["discarded_count_max"] = max(discarded)
    return out


def report_md(result, phases, outdir):
    t = result.get("timings", {})
    prov = result.get("provenance") or {}
    binary_info = prov.get("binary") or {}
    probe_info = prov.get("probe") or {}
    if prov.get("git_clean") is None:
        git_state = "unknown"
    elif prov.get("git_clean"):
        git_state = "clean"
    else:
        git_state = "dirty (see result.json)"

    def parent_cell(p):
        if p.get("parent_priv_mb") is None:
            return "-"
        return f"{p['parent_priv_mb']}/{p['parent_priv_mb_max']}"

    lines = [
        "# Web-tab stress",
        "",
        "| | |",
        "|---|---|",
        f"| build | `{result.get('binary')}` |",
        f"| sleep policy | enabled `{result.get('marionette_prefs', {}).get('enabled')}`, "
        f"viewport {result.get('marionette_prefs', {}).get('policy')} |",
        f"| provenance | git {prov.get('git_head')}, "
        f"{git_state}, binary "
        f"{binary_info.get('size')} bytes @ {binary_info.get('mtime')}, probe sha256 "
        f"{prov.get('probe_sha256')} @ {probe_info.get('mtime')} |",
        f"| profile | fresh (cold cache), {result.get('cache_mb_after')} MB / "
        f"{result.get('cache_entries_after')} entries written |",
        f"| content processes | `dom.ipc.processCount` = {result.get('ipc_process_count')} "
        f"(read from the build) |",
        f"| tabs | {result.get('opened')} opened, {result.get('walked')} walked, "
        f"{len(result.get('tabs_final', []))} at steady |",
        f"| open (host) | {t.get('open_ms')} ms |",
        f"| walk | {t.get('walk_s')} s |",
        f"| activate (cold) | median {t.get('activate_med')} ms, p95 {t.get('activate_p95')} ms, "
        f"max {t.get('activate_max')} ms (includes the walk dwell) |",
    ]
    if t.get("warm_activate_ms"):
        lines.append(f"| activate (warm) | median {t.get('warm_activate_med')} ms, "
                     f"p95 {t.get('warm_activate_p95')} ms, max {t.get('warm_activate_max')} ms "
                     f"(discarded tabs, clock after the dwell) |")
    lines += [
        f"| videos | {result.get('video_tabs')} tabs, "
        f"{result.get('muted_ok')}/{result.get('video_tabs')} muted"
        + (f", {result.get('paused_ok')}/{result.get('video_tabs')} paused"
           if result.get("pause_video") else "") + " |",
        f"| chrome UI | median frame {t.get('frame_med')} ms, p99 {t.get('frame_p99')} ms, "
        f"max {t.get('frame_max')} ms |",
        f"| tab switch | {', '.join(str(x) for x in t.get('switch_ms', []))} ms |",
        "",
        "## Phases (Astra process tree only)",
        "",
        "| phase | s | private MB (med/max) | parent MB (med/max) | working set MB | "
        "CPU cores (med/max) | % machine | GPU % | video decode % | discarded | awake | "
        "procs | net KB/s |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, p in phases.items():
        discarded = p.get("discarded_count")
        awake = p.get("awake_count")
        lines.append(
            f"| {name} | {p['seconds']} | {p['priv_mb_med']}/{p['priv_mb_max']} | "
            f"{parent_cell(p)} | {p['ws_mb_max']} | "
            f"{p['cpu_cores_med']}/{p['cpu_cores_max']} | {p['cpu_pct_of_machine_max']} | "
            f"{p['gpu_max']} | {p['video_decode_max']} | "
            f"{'-' if discarded is None else discarded} | "
            f"{'-' if awake is None else awake} | "
            f"{p['procs_max']} | {p['net_kbps_max']} |")
    hold = result.get("idle_hold")
    if hold:
        last = hold["observations"][-1]
        lines += ["", f"Idle hold: {hold['seconds']} s untouched, {last.get('discarded')} discarded / "
                  f"{last.get('awake')} awake at the end "
                  f"({last.get('total')} tabs), {hold.get('rows_annotated', 0)} rows stamped."]
    audit = result.get("discard_audit")
    if audit:
        counts = result.get("discard_audit_counts") or {}
        lines += ["", "## Discard audit (end of idle hold)", "",
                  "| reason | tabs |", "|---|---|"]
        for reason in ("discarded", "audible", "warm", "other"):
            lines.append(f"| {reason} | {counts.get(reason, 0)} |")
        other = [r for r in audit if r.get("reason") == "other"]
        if other:
            lines += ["", "Awake and unexplained: " + ", ".join(
                f"`{r['id']}` {r['url'][:60]}" for r in other[:10])]
    reclaim = result.get("reclaim")
    if reclaim:
        under = reclaim["first_ts_under_10pct"] is not None
        lines += ["", "## Reclaim after closing every tab", "",
                  f"Before {reclaim['before_priv_mb']} MB, sampled for {reclaim['wait_s']} s; "
                  + (f"first sample under 10 % at {reclaim['first_ts_under_10pct']} "
                     f"({reclaim['first_s_under_10pct']} s after close); "
                     if under else "no sample reached 10 %; ")
                  + f"final {reclaim['final_priv_mb']} MB.", "",
                  "| t (s) | private MB | % of before |", "|---|---|---|"]
        for p in reclaim["points"]:
            lines.append(f"| {p['t_s']} | {p['priv_mb']} | {p['pct_of_before']} |")
    visible = result.get("probes", {}).get("stage_video")
    if visible:
        v = visible.get("video") or {}
        lines += ["", f"Visible stage: {visible.get('fps')} fps, " +
                  f"{v.get('w')}x{v.get('h')} {v.get('decoded_frames')} decoded / "
                  f"{v.get('dropped_frames')} dropped frames in 5 s."]
    if result.get("stage_skipped"):
        lines += ["", f"Stage probe skipped: {result['stage_skipped']}."]
    untitled = [x for x in result.get("tabs_final", []) if not x["title"]]
    if untitled:
        lines += ["", "Tabs with no title: " + ", ".join(f"`{x['id']}` {x['url'][:60]}" for x in untitled)]
    path = os.path.join(outdir, "REPORT.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tabs", type=int, default=len(URLS), help="how many of the site list to open")
    ap.add_argument("--steady", type=int, default=45, help="seconds at steady state")
    ap.add_argument("--video", type=int, default=25, help="seconds with background video suspension off")
    ap.add_argument("--dwell", type=int, default=700, help="ms to dwell on each tab while walking")
    ap.add_argument("--idle-hold", type=int, default=0,
                    help="seconds to leave the window untouched after steady (sleeping tabs)")
    ap.add_argument("--close-wait", type=int, default=20,
                    help="seconds to sample the reclaim after closing every tab")
    ap.add_argument("--pause-video", action="store_true",
                    help="pause every video tab after the load poll")
    ap.add_argument("--port", type=int, default=2901)
    ap.add_argument("--out", default=None, help="output directory (default out/web-tabs-<stamp>)")
    ap.add_argument("--keep-profile", action="store_true")
    ap.add_argument("--no-video-phase", action="store_true")
    args = ap.parse_args()

    binary = resolve_binary()
    if not binary:
        print("SKIP no built binary (set ASTRA_BINARY or build engine/" + OBJ + ")")
        return 2

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    outdir = args.out or os.path.join(ROOT, "out", f"web-tabs-{stamp}")
    os.makedirs(outdir, exist_ok=True)
    profile = os.path.join(tempfile.gettempdir(), f"astra-web-tabs-{stamp}")
    urls = URLS[: max(1, args.tabs)]
    sampler = sample_backend(binary, outdir)
    httpd, stage_video = serve_fixtures()
    result = {
        "binary": binary, "profile": profile, "urls": len(urls), "phases": {},
        "probes": {}, "timings": {}, "pause_video": args.pause_video,
        "provenance": provenance(binary),
    }
    workers = os.cpu_count() or 1
    proc = log = m = None
    root_pid = None
    try:
        result["reaped_before"] = sampler.reap()
        proc, log = launch(binary, profile, args.port)
        root_pid = proc.pid
        sampler.root_pid = root_pid
        result["phases"]["launch"] = time.time()
        sampler.start()
        m = Marionette(args.port, timeout=180)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 600000, "implicit": 0, "pageLoad": 180000})
        ipc = json.loads(m.chrome("""return JSON.stringify((() => {
          try { return { value: Services.prefs.getIntPref('dom.ipc.processCount') }; }
          catch (e) { return { error: String(e) }; }
        })())"""))
        result["ipc_process_count"] = ipc.get("value")
        time.sleep(8)
        # Marionette's recommended preferences disable tab unloading. That is
        # the same pref as Astra's sleep master switch, so a driven run would
        # measure a browser that never sleeps anything. Clear the user value so
        # the build's own default applies, and record both facts.
        policy = json.loads(m.chrome("""return JSON.stringify((() => {
          const P = 'browser.tabs.unloadOnLowMemory';
          const def = Services.prefs.getDefaultBranch('').getBoolPref(P);
          const had = Services.prefs.prefHasUserValue(P);
          try { Services.prefs.clearUserPref(P); } catch (e) {}
          return {
            browser_pid: Services.appinfo.processID,
            marionette_value: had ? false : null,
            default_value: def,
            value: Services.prefs.getBoolPref(P),
            user: Services.prefs.prefHasUserValue(P),
            enabled: Services.astraHost.Settings.current('performance.sleep'),
            policy: Services.astraHost.Performance.status().policy,
          };
        })())"""))
        result["marionette_prefs"] = policy
        result["browser_pid"] = policy.get("browser_pid")
        if str(policy.get("enabled")) != "true":
            raise RuntimeError(
                f"sleep policy is off after Marionette prefs: {json.dumps(policy)[:300]}")
        result["phases"]["baseline"] = time.time()
        time.sleep(8)

        result["phases"]["open"] = time.time()
        opened = json.loads(m.chrome_async(OPEN, [urls]))
        tabs = [t for t in opened.get("tabs", []) if t.get("id")]
        result["opened"] = len(tabs)
        result["timings"]["open_ms"] = opened.get("total_ms")

        time.sleep(5)
        lazy = json.loads(m.chrome(LOADED_NOW))
        result["lazy_after_open"] = {
            "tabs": len(lazy),
            "loaded": sum(1 for t in lazy if t["uri"] not in ("about:blank", "")),
        }

        ids = [t["id"] for t in tabs]
        t0 = time.time()
        walk = []
        aborted = None
        for start in range(0, len(ids), 10):
            walk.extend(json.loads(m.chrome_async(WALK, [ids[start:start + 10], args.dwell])))
            rows = sampler.rows()
            avail = (rows[-1]["mem_avail"] if rows else 99999) or 99999
            if avail < 1500:
                aborted = f"available RAM {avail:.0f} MB after {len(walk)} tabs"
                break
        result["phases"]["walked"] = time.time()
        result["walk"] = walk
        result["walk_aborted"] = aborted
        result["timings"]["walk_s"] = round(time.time() - t0, 1)
        acts = [w["activate_ms"] for w in walk if "activate_ms" in w]
        if acts:
            acts.sort()
            result["timings"].update({"activate_med": acts[len(acts) // 2],
                                      "activate_p95": acts[int(len(acts) * 0.95)],
                                      "activate_max": acts[-1]})
        result["walked"] = len(walk)

        curve = json.loads(m.chrome_async(LOAD_POLL, [200000], 300000))
        result["phases"]["loaded"] = time.time()
        result["load_curve"] = curve[-1] if curve else {}

        video_ids = [tid for url, tid in zip([t["url"] for t in tabs], ids)
                     if any(h in url for h in VIDEO_HINTS)]
        result["video_tabs"] = len(video_ids)
        if args.pause_video:
            result["probes"]["paused"] = json.loads(m.chrome_async(PAUSE_VIDEO, [video_ids]))
            result["paused_ok"] = sum(1 for x in result["probes"]["paused"] if x.get("paused"))
        result["probes"]["muted"] = json.loads(m.chrome_async(MUTE, [video_ids]))
        result["muted_ok"] = sum(1 for x in result["probes"]["muted"] if x.get("muted"))

        time.sleep(10)
        result["phases"]["steady"] = time.time()
        time.sleep(max(1, args.steady))

        if args.idle_hold > 0:
            result["phases"]["idle_hold"] = time.time()
            observations = []
            deadline = time.time() + args.idle_hold
            while True:
                started = time.time()
                counts = json.loads(m.chrome(TAB_COUNTS))
                counts["ts"] = round(started, 3)
                observations.append(counts)
                left = deadline - time.time()
                if left <= 0:
                    break
                time.sleep(min(5.0, left))
            counts = json.loads(m.chrome(TAB_COUNTS))
            counts["ts"] = round(time.time(), 3)
            observations.append(counts)
            result["phases"]["idle_hold_end"] = time.time()
            result["idle_hold"] = {"seconds": args.idle_hold, "observations": observations}
            try:
                audit = json.loads(m.chrome(DISCARD_AUDIT))
            except Exception as exc:  # noqa: BLE001 - the audit never fails the run
                audit = []
                result["probes"]["discard_audit_error"] = str(exc)
            result["discard_audit"] = audit
            if audit:
                result["discard_audit_counts"] = classify_audit(audit, walk)

        result["probes"]["chrome_frames"] = json.loads(m.chrome_async(CHROME_FRAMES, [6000]))
        result["probes"]["tab_pids"] = json.loads(m.chrome_async(TAB_PIDS))
        result["probes"]["media_view"] = json.loads(m.chrome(MEDIA_VIEW))

        counts = json.loads(m.chrome(TAB_COUNTS))
        result["probes"]["tab_counts_after_steady"] = counts
        discarded_ids = counts.get("discarded_ids") or []
        warm_walk = []
        if discarded_ids:
            warm_walk = json.loads(m.chrome_async(REWALK, [discarded_ids, args.dwell], 900000))
        result["probes"]["warm_walk"] = warm_walk
        warm = [w["warm_activate_ms"] for w in warm_walk if w.get("warm_activate_ms") is not None]
        result["timings"]["warm_activate_ms"] = warm
        if warm:
            warm_sorted = sorted(warm)
            result["timings"].update({
                "warm_activate_med": warm_sorted[len(warm_sorted) // 2],
                "warm_activate_p95": warm_sorted[int(len(warm_sorted) * 0.95)],
                "warm_activate_max": warm_sorted[-1],
            })
        result["probes"]["switch_ms"] = json.loads(m.chrome_async(SWITCH))

        try:
            stage = json.loads(m.chrome_async(STAGE_SELECT))
            result["probes"]["stage_select"] = stage
            if not stage.get("ok"):
                result["stage_skipped"] = stage.get("reason") or "no awake tab"
            else:
                m.chrome(STAGE_LOAD, [stage_video])
                m.cmd("Marionette:SetContext", {"value": "content"})
                handles = m.cmd("WebDriver:GetWindowHandles")["value"]
                index = stage.get("index", 0)
                ordered = []
                if 0 <= index < len(handles):
                    ordered.append(handles[index])
                for handle in handles:
                    if len(ordered) >= 6:
                        break
                    if handle not in ordered:
                        ordered.append(handle)
                target = stage_video.split("?")[0]
                opened = False
                for position, handle in enumerate(ordered):
                    try:
                        # Selection already happened in chrome; do not re-select
                        # a tab or pull OS focus back to the window.
                        m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": False})
                        time.sleep(6 if position == 0 else 2)
                        href = str(m.execute("return location.href"))
                    except Exception:  # noqa: BLE001 - a stale or discarded candidate
                        continue
                    if href.startswith(target):
                        opened = True
                        break
                if not opened:
                    result["stage_skipped"] = "stage page did not open"
                else:
                    result["probes"]["stage_video"] = json.loads(m.execute_async(STAGE_VIDEO, [5000]))
        except Exception as exc:  # noqa: BLE001 - the stage probe never fails the run
            result["stage_skipped"] = f"stage probe error: {exc}"

        result["phases"]["video_phase"] = time.time()
        if not args.no_video_phase:
            try:
                m.chrome("""Services.prefs.setBoolPref('media.suspend-background-video.enabled', false);
                  Services.prefs.setIntPref('media.suspend-background-video.delay-ms', 0);
                  return 'ok'""")
                for start in range(0, len(video_ids), 5):
                    m.chrome_async(WALK, [video_ids[start:start + 5], 350])
            except Exception as exc:  # noqa: BLE001
                result["probes"]["video_phase_error"] = str(exc)
            time.sleep(8)
            time.sleep(max(1, args.video))
        result["phases"]["video_phase_end"] = time.time()

        try:
            shot = m.cmd("WebDriver:TakeScreenshot", {"full": False, "hash": False, "highlights": []})
            with open(os.path.join(outdir, "tabs.png"), "wb") as fh:
                fh.write(base64.b64decode(shot["value"] if isinstance(shot, dict) else shot))
        except Exception as exc:  # noqa: BLE001
            result["probes"]["screenshot_error"] = str(exc)

        result["tabs_final"] = json.loads(m.chrome(TAB_STATE))
        frames = result["probes"]["chrome_frames"]
        frames_sorted = sorted(frames)
        result["timings"].update({
            "frame_med": frames_sorted[len(frames_sorted) // 2],
            "frame_p99": frames_sorted[int(len(frames_sorted) * 0.99)],
            "frame_max": frames_sorted[-1],
            "switch_ms": result["probes"]["switch_ms"],
        })

        cache = os.path.join(profile, "cache2")
        entries = size = 0
        for root, _dirs, files in os.walk(cache):
            for name in files:
                entries += 1
                try:
                    size += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
        result["cache_entries_after"] = entries
        result["cache_mb_after"] = round(size / 1e6, 1)

        result["phases"]["close"] = time.time()
        result["probes"]["close"] = json.loads(m.chrome_async(CLOSE_ALL))
        time.sleep(max(0, args.close_wait))
        result["phases"]["end"] = time.time()
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001
        import traceback
        result["error"] = str(exc)
        result["traceback"] = traceback.format_exc()
        print(f"web_tabs_probe: FAIL {exc}", file=sys.stderr)
    finally:
        sampler.stop()
        if m:
            try:
                m.sock.close()
            except Exception:  # noqa: BLE001
                pass
        if proc:
            try:
                proc.terminate()
                proc.wait(timeout=20)
            except Exception:  # noqa: BLE001
                proc.kill()
        time.sleep(2)
        result["reaped_after"] = sampler.reap()
        if log:
            log.close()
        try:
            httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
        rows = sampler.rows()
        stamped = annotate_hold(rows, (result.get("idle_hold") or {}).get("observations"),
                                result["phases"])
        if stamped:
            with open(sampler.samples, "w", encoding="utf-8") as fh:
                for row in rows:
                    fh.write(json.dumps(row) + "\n")
            result["idle_hold"]["rows_annotated"] = stamped
        result["reclaim"] = reclaim_curve(result, rows)
        phases = summarize(result, rows, workers, result.get("browser_pid") or root_pid)
        result["phases_summary"] = phases
        with open(os.path.join(outdir, "result.json"), "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
        if phases and result.get("phases"):
            print("report:", report_md(result, phases, outdir))
        if not args.keep_profile:
            shutil.rmtree(profile, ignore_errors=True)
        print("out:", outdir)

    if not result.get("ok"):
        return 1
    print(f"PASS {result.get('opened')} tabs, {result.get('walked')} walked, "
          f"{result.get('muted_ok')}/{result.get('video_tabs')} video tabs muted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
