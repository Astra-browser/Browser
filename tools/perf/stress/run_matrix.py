#!/usr/bin/env python3
"""Stress-matrix runner: one scenario, one browser, one fresh profile.

Every run launches the real headed browser, drives it over Marionette, samples
CPU / RAM / GPU once a second while the workload is running, then writes:

  <run>/samples.jsonl     raw per-sample process table
  <run>/summary.json      per-phase aggregates + process-kind roll-ups
  <run>/reports.jsonl     page heartbeats (rAF, video frames, GL renderer)
  <run>/tabs.json         tab -> content-process mapping when available
  <run>/REPORT.md         the automatic per-run report
  <run>/ui_actions.json   UI-tour latencies/checks (ui-tour only)
  <run>/shots/*.png       chrome screenshots

and appends the same run to ../../observations.md (repo root).

Usage:
  python3 run_matrix.py --browser astra --scenario baseline-1tab
  python3 run_matrix.py --browser both --scenario all --repeat 2
"""
import argparse
import base64
import glob
import json
import os
import re
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, HERE)

from profiler import (  # noqa: E402
    Sampler, system_cpu, system_mem, loadavg, find_intel_card, _read, _int, pct,
)

ASTRA_BIN = os.environ.get(
    "ASTRA_BINARY", os.path.join(ROOT, "engine", "obj-astra-linux", "dist", "bin", "firefox")
)
STOCK_BIN = os.environ.get("STOCK_FIREFOX", "/usr/bin/firefox")
FIXTURES = os.path.join(HERE, "fixtures")
OBSERVATIONS = os.path.join(ROOT, "observations.md")
PORTS = [8111, 8112, 8113, 8114]


# --------------------------------------------------------------------------
# Marionette client (stdlib; same wire format the repo's probes use)
# --------------------------------------------------------------------------
class Marionette:
    def __init__(self, port, timeout=90):
        deadline = time.time() + timeout
        last = None
        self.sock = None
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
                break
            except OSError as exc:
                last = exc
                time.sleep(0.1)
        if self.sock is None:
            raise RuntimeError(f"marionette never came up on {port}: {last}")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()  # server handshake

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
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("marionette closed mid-message")
            rest += chunk
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

    def close(self):
        try:
            self.f.close()
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# JS snippets shared by both browsers
# --------------------------------------------------------------------------
APP_READY = """return JSON.stringify((() => {
  const f = document.querySelector('iframe[data-astra-app-frame]');
  const d = f && f.contentDocument;
  const root = d && d.getElementById('root');
  return {
    frame: !!f,
    rootKids: root ? root.children.length : 0,
    opacity: root ? (root.style.opacity || '1') : null,
    bridgeMode: root ? (root.dataset.bridgeMode ?? null) : null,
    title: document.title,
    outer: [window.outerWidth, window.outerHeight],
    inner: [window.innerWidth, window.innerHeight],
  };
})())"""

ASTRA_STATE = """return JSON.stringify((() => {
  const f = document.querySelector('iframe[data-astra-app-frame]');
  const d = f && f.contentDocument;
  const shell = d && d.querySelector('.shell');
  const alerts = d ? [...d.querySelectorAll('[role=alert]')].map(a => (a.textContent||'').trim()).slice(0,5) : [];
  return {
    surface: shell ? shell.getAttribute('data-astra-surface') : null,
    active: shell ? shell.getAttribute('data-astra-active-tab') : null,
    tabs: d ? [...d.querySelectorAll('[data-astra-tab-id]')].map(r => r.getAttribute('data-astra-tab-id')) : [],
    alerts,
    appReady: d && d.getElementById('root') ? d.getElementById('root').dataset.bridgeMode : null,
  };
})())"""

ACTIVE_BROWSER = """return JSON.stringify((() => {
  const b = document.querySelector('browser[data-astra-browser]');
  if (!b) return { ok: false, why: 'no-active-browser' };
  let uri = ''; let loading = null; let title = null;
  try { uri = b.currentURI.spec; } catch (e) { uri = 'ERR'; }
  try { loading = b.webProgress ? b.webProgress.isLoadingDocument : null; } catch (e) {}
  try { title = b.contentTitle; } catch (e) {}
  const r = b.getBoundingClientRect();
  return { ok: true, uri, loading, title, rect: [Math.round(r.width), Math.round(r.height)] };
})())"""

TAB_MAP_ASTRA = """return JSON.stringify([...document.querySelectorAll('browser')].map((b) => {
  let uri = null; let pid = null; let docActive = null; let bcActive = null;
  try { uri = b.currentURI ? b.currentURI.spec : null; } catch (e) {}
  try { pid = b.frameLoader?.remoteTab?.pid ?? null; } catch (e) {}
  try { docActive = b.docShellIsActive; } catch (e) {}
  try { bcActive = b.browsingContext ? b.browsingContext.isActive : null; } catch (e) {}
  return { uri, pid, parked: b.hasAttribute('data-astra-browser-parked'), docActive, bcActive };
}))"""

STOCK_TAB_MAP = """return JSON.stringify([...gBrowser.tabs].map((t, i) => {
  let uri = null; let pid = null;
  try { uri = t.linkedBrowser.currentURI.spec; } catch (e) {}
  try { pid = t.linkedBrowser.frameLoader?.remoteTab?.pid ?? null; } catch (e) {}
  const r = t.linkedBrowser.getBoundingClientRect();
  return { i, uri, pid, rect: [Math.round(r.width), Math.round(r.height)] };
}))"""

INJECT_LAG = """(() => {
  window.__stressLag = { max: 0, last: performance.now(), frames: 0 };
  (function tick() {
    const n = performance.now();
    const gap = n - window.__stressLag.last;
    if (gap > window.__stressLag.max) window.__stressLag.max = gap;
    window.__stressLag.last = n;
    window.__stressLag.frames += 1;
    requestAnimationFrame(tick);
  })();
  try {
    const f = document.querySelector('iframe[data-astra-app-frame]');
    const w = f && f.contentWindow;
    if (w) {
      w.__stressLag = { max: 0, last: w.performance.now(), frames: 0 };
      (function tick() {
        const n = w.performance.now();
        const gap = n - w.__stressLag.last;
        if (gap > w.__stressLag.max) w.__stressLag.max = gap;
        w.__stressLag.last = n;
        w.__stressLag.frames += 1;
        w.requestAnimationFrame(tick);
      })();
    }
  } catch (e) {}
  return 'ok';
})()"""

READ_LAG = """return JSON.stringify((() => {
  let app = null;
  try {
    const f = document.querySelector('iframe[data-astra-app-frame]');
    app = f && f.contentWindow ? (f.contentWindow.__stressLag ?? null) : null;
  } catch (e) {}
  return { chrome: window.__stressLag ?? null, app };
})())"""


# --------------------------------------------------------------------------
# Scenario matrix
# --------------------------------------------------------------------------
def paged(path, **params):
    return (path, params)


SCENARIOS = {
    "baseline-1tab": {
        "desc": "One tab on a local blank page (browser + UI baseline).",
        "tabs": [paged("/blank.html")],
        "steady": 25,
    },
    "baseline-newtab": {
        "desc": "One New Tab, no page loaded (chrome/UI-only baseline).",
        "tabs": [("about:blank", {})],
        "steady": 20,
        "stock": {"tabs": [("about:blank", {})]},
    },
    "tabs-8static": {
        "desc": "Eight tabs on four loopback origins, static layout/paint content.",
        "tabs": [paged("/static.html")] * 8,
        "steady": 25,
    },
    "video-2": {
        "desc": "Two tabs playing 1080p30 video (H.264 + VP9).",
        "tabs": [paged("/video.html", codec="h264"), paged("/video.html", codec="vp9")],
        "steady": 30,
        "expect_video": 2,
    },
    "video-6": {
        "desc": "Six tabs playing 1080p30 video (3x H.264, 3x VP9).",
        "tabs": [paged("/video.html", codec=("h264" if i % 2 == 0 else "vp9")) for i in range(6)],
        "steady": 30,
        "expect_video": 6,
    },
    "3d-1": {
        "desc": "One tab running a heavy WebGL2 scene at a fixed 1280x720 with gl.finish() (true GPU throughput).",
        "tabs": [paged("/3d.html", w=1280, h=720, sync=1)],
        "steady": 30,
        "expect_gl": 1,
    },
    "3d-4": {
        "desc": "Four fixed-720p WebGL tabs (one visible, three background-throttled).",
        "tabs": [paged("/3d.html", w=1280, h=720, sync=1)] * 4,
        "steady": 25,
        "expect_gl": 1,
    },
    "mixed-8": {
        "desc": "Eight tabs: 2 video, 2 WebGL (fixed 720p sync), 2 JS-burn, 2 static.",
        "tabs": [
            paged("/video.html", codec="h264"),
            paged("/video.html", codec="vp9"),
            paged("/3d.html", w=1280, h=720, sync=1),
            paged("/3d.html", w=1280, h=720, sync=1),
            paged("/js.html"),
            paged("/js.html"),
            paged("/static.html"),
            paged("/static.html"),
        ],
        "steady": 30,
        "expect_video": 2,
    },
    "memory-6": {
        "desc": "Six tabs each holding ~64 MiB resident + 12k DOM nodes.",
        "tabs": [paged("/memory.html", mb=64)] * 6,
        "steady": 20,
    },
    "ui-tour": {
        "desc": "Six static tabs, then real UI actions (tab create/switch, address bar, sidebar, Work/Browse, settings menu).",
        "tabs": [paged("/static.html")] * 6,
        "steady": 30,
        "ui": True,
    },
}


def tab_urls(scenario, ports):
    specs = []
    for i, (path, params) in enumerate(scenario["tabs"]):
        if path == "about:blank":
            specs.append(("about:blank", {}))
            continue
        q = "&".join(f"{k}={v}" for k, v in params.items())
        q = f"id=t{i}&kind={path.strip('/').split('.')[0]}" + (f"&{q}" if q else "")
        specs.append((f"http://127.0.0.1:{ports[i % len(ports)]}{path}?{q}", {"id": f"t{i}"}))
    return specs


# --------------------------------------------------------------------------
# Browser drivers
# --------------------------------------------------------------------------
class BrowserRun:
    def __init__(self, kind, outdir, profile, port, repeat):
        self.kind = kind  # astra | stock
        self.outdir = outdir
        self.profile = profile
        self.port = port
        self.repeat = repeat
        self.proc = None
        self.m = None
        self.events = {}
        self.timings = {}
        self.tab_ids = []
        self.errors = []

    @property
    def binary(self):
        return ASTRA_BIN if self.kind == "astra" else STOCK_BIN

    def _user_js(self):
        prefs = {
            "marionette.port": self.port,
            "browser.shell.checkDefaultBrowser": False,
            "browser.aboutwelcome.enabled": False,
            "browser.startup.homepage_override.mstone": "ignore",
            "browser.startup.page": 0,
            "browser.startup.homepage": "about:blank",
            "browser.newtabpage.enabled": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.enabled": False,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "app.update.enabled": False,
            "app.update.auto": False,
            "browser.sessionstore.resume_from_crash": False,
            "media.autoplay.default": 0,
            "media.autoplay.blocking_policy": 0,
            "dom.max_script_run_time": 0,
            "dom.max_chrome_script_run_time": 0,
            "browser.tabs.warnOnClose": False,
            "browser.warnOnQuit": False,
            "browser.tabs.inTitlebar": 0,
            "network.prefetch-next": False,
            "network.dns.disablePrefetch": True,
            "network.http.speculative-parallel-limit": 0,
            "extensions.pocket.enabled": False,
            "identity.fxaccounts.enabled": False,
            "browser.messaging-system.whatsNewPanel.enabled": False,
            "browser.newtabpage.activity-stream.showSponsored": False,
            "browser.newtabpage.activity-stream.showSponsoredTopSites": False,
            "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons": False,
            "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features": False,
            "browser.discovery.enabled": False,
            "browser.vpn_promo.enabled": False,
            "browser.feedback.enabled": False,
        }
        with open(os.path.join(self.profile, "user.js"), "w", encoding="utf-8") as fh:
            for key, value in prefs.items():
                fh.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")

    def launch(self, sampler):
        os.makedirs(self.profile, exist_ok=True)
        self._user_js()
        args = [
            os.path.abspath(self.binary),
            "-profile", os.path.abspath(self.profile),
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ]
        env = os.environ.copy()
        env["MOZ_ENABLE_WAYLAND"] = "1"
        env["MOZ_CRASHREPORTER_DISABLE"] = "1"
        # Firefox 159 (stock) rejects chrome context without this; ESR 153
        # accepts the CLI flag, keeping it here makes both paths identical.
        env["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"
        env.setdefault("XDG_SESSION_TYPE", "wayland")
        log = open(os.path.join(self.outdir, "browser.log"), "wb")
        sampler.mark("spawn")
        t0 = time.monotonic()
        self.proc = subprocess.Popen(
            args,
            cwd=os.path.dirname(os.path.abspath(self.binary)),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        sampler.root_pid = self.proc.pid
        self.events["spawn_mono"] = t0
        sampler.start()

    def connect(self, sampler):
        t0 = time.monotonic()
        self.m = Marionette(self.port, timeout=90)
        sampler.mark("marionette")
        self.timings["spawn_to_marionette_ms"] = round((time.monotonic() - t0) * 1000)
        self.m.cmd("WebDriver:NewSession", {"capabilities": {}})
        self.m.cmd("Marionette:SetContext", {"value": "chrome"})
        try:
            self.m.cmd("WebDriver:SetTimeouts", {"script": 180000, "pageLoad": 300000, "implicit": 0})
        except Exception:
            pass
        sampler.mark("session")

    def wait_ready(self, sampler):
        t0 = time.monotonic()
        deadline = t0 + 90
        last = None
        while time.monotonic() < deadline:
            try:
                if self.kind == "astra":
                    st = json.loads(self.m.execute(APP_READY))
                    ready = (st.get("frame") and (st.get("rootKids") or 0) > 0
                             and st.get("bridgeMode") == "host" and st.get("opacity") != "0")
                    last = st
                else:
                    raw = self.m.execute("return document.readyState + '|' + typeof gBrowser")
                    ready = raw.startswith("complete|") and raw != "complete|undefined"
                    last = raw
                if ready:
                    break
            except Exception as exc:
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(0.1)
        sampler.mark("ui-ready")
        self.timings["spawn_to_ui_ready_ms"] = round((time.monotonic() - self.events["spawn_mono"]) * 1000)
        self.timings["ready_state"] = last
        # Normalise window geometry for a fair GPU/compositor comparison.
        # Hyprland tiles new windows into whatever split is free, which gave
        # the first smoke run a 942x1062 viewport: not comparable to stock.
        self._hypr_geometry()
        try:
            self.m.execute("try { window.resizeTo(1600, 1000); } catch(e) {} return 'ok'")
        except Exception:
            pass
        time.sleep(0.5)
        try:
            geo = json.loads(self.m.execute("""return JSON.stringify({
              outer: [window.outerWidth, window.outerHeight],
              inner: [window.innerWidth, window.innerHeight],
              dpr: window.devicePixelRatio,
            })"""))
        except Exception:
            geo = None
        self.timings["window"] = geo
        self.start_focus_watchdog()
        try:
            self.timings["graphics"] = json.loads(self.m.execute("""return JSON.stringify((() => {
              try {
                const gfx = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo);
                const info = gfx.getInfo();
                let layerManager = null; let vsync = null;
                try { layerManager = window.windowUtils.layerManagerType; } catch (e) {}
                try { vsync = window.windowUtils.getVsyncRate ? window.windowUtils.getVsyncRate() : null; } catch (e) {}
                return {
                  adapter: String(info.adapterDescription || ''),
                  vendor: String(info.vendor || ''),
                  device: String(info.deviceID || ''),
                  webrender_all: Services.prefs.getBoolPref('gfx.webrender.all', false),
                  webrender_software: Services.prefs.getBoolPref('gfx.webrender.software', false),
                  layer_manager: layerManager,
                  vsync_hz: vsync,
                };
              } catch (e) { return { error: String(e) }; }
            })())"""))
        except Exception:
            pass
        return bool(ready)

    def _hypr_geometry(self):
        if not self.proc or not shutil.which("hyprctl"):
            return
        # Hyprland 0.57 uses Lua dispatchers; `hyprctl dispatch` parses its
        # argument as Lua. Normalise the test window to a fixed float size so
        # Astra and stock render the same number of pixels.
        code = (
            f"local w=hl.get_window('pid:{self.proc.pid}'); "
            "if not w then return 'no-window' end; "
            "hl.dispatch(hl.dsp.window.float({action='enable', window=w})); "
            "hl.dispatch(hl.dsp.window.resize({x=1600,y=1000,exact=true,window=w})); "
            "hl.dispatch(hl.dsp.window.move({x=100,y=40,window=w})); "
            "hl.dispatch(hl.dsp.focus({window=w})); "
            "return 'ok'"
        )
        try:
            subprocess.run(["hyprctl", "eval", code], capture_output=True, timeout=5)
        except Exception:
            pass
        time.sleep(0.4)

    def _hypr_focus(self):
        if not self.proc or not shutil.which("hyprctl"):
            return False
        code = (f"local w=hl.get_window('pid:{self.proc.pid}'); "
                "if not w then return 'no-window' end; "
                "hl.dispatch(hl.dsp.focus({window=w})); "
                "hl.dispatch(hl.dsp.window.bring_to_top({window=w})); "
                "return 'ok'")
        try:
            r = subprocess.run(["hyprctl", "eval", code], capture_output=True, text=True, timeout=5)
            return "ok" in (r.stdout or "")
        except Exception:
            return False

    def start_focus_watchdog(self):
        """Keep the measured window visible for animated workloads.

        An unfocused/occluded window is throttled by both browsers; without
        this, a background terminal can turn a 144 fps run into a 60 fps run.
        Only enabled with ASTRA_STRESS_FOCUS=1 so normal runs are untouched.
        """
        if os.environ.get("ASTRA_STRESS_FOCUS") != "1":
            return
        self._focus_stop = threading.Event()

        def loop():
            while not self._focus_stop.is_set():
                self._hypr_focus()
                self._focus_stop.wait(1.5)

        self._focus_thread = threading.Thread(target=loop, daemon=True)
        self._focus_thread.start()
        self.timings["focus_watchdog"] = True

    # ---- Astra ---------------------------------------------------------
    def astra_create_tab(self, url):
        script = """const url = arguments[0];
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const r = await window.__astraHost.Tabs.create({ request_id: 'stress', url, background: false });
            done(JSON.stringify(r));
          } catch (e) { done(JSON.stringify({ error: String(e) })); }
        })();"""
        raw = self.m.execute_async(script, [url])
        try:
            return json.loads(raw)
        except Exception:
            return {"raw": raw}

    def astra_select_tab(self, tab_id):
        script = """const id = arguments[0];
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const r = await window.__astraHost.Tabs.select({ request_id: 'stress', astra_tab_id: id });
            done(JSON.stringify(r));
          } catch (e) { done(JSON.stringify({ error: String(e) })); }
        })();"""
        raw = self.m.execute_async(script, [tab_id])
        try:
            return json.loads(raw)
        except Exception:
            return {"raw": raw}

    def wait_active_page(self, timeout=30, expect_substr=None):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                st = json.loads(self.m.execute(ACTIVE_BROWSER))
                last = st
                uri = st.get("uri") or ""
                if (st.get("ok") and st.get("loading") is False
                        and uri.startswith("http")
                        and (expect_substr is None or expect_substr in uri)):
                    return st
            except Exception as exc:
                last = {"error": str(exc)}
            time.sleep(0.15)
        return last or {"error": "timeout"}

    def wait_astra_loaded(self, timeout=30, expect_substr=None):
        return self.wait_active_page(timeout, expect_substr)

    # ---- stock ---------------------------------------------------------
    def stock_add_tab(self, url):
        script = """const url = arguments[0];
        const tab = gBrowser.addTab(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          skipAnimation: true,
        });
        return String(gBrowser.tabs.length - 1);"""
        return self.m.execute(script, [url])

    def stock_wait_loaded(self, index, timeout=30, expect_substr=None):
        script = """const i = arguments[0];
        const t = gBrowser.tabs[i];
        if (!t) return JSON.stringify({ ok: false, why: 'no-tab' });
        const b = t.linkedBrowser;
        let uri = ''; let loading = null;
        try { uri = b.currentURI.spec; } catch (e) {}
        try { loading = b.webProgress ? b.webProgress.isLoadingDocument : null; } catch (e) {}
        const r = b.getBoundingClientRect();
        return JSON.stringify({ ok: true, uri, loading, rect: [Math.round(r.width), Math.round(r.height)] });"""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                st = json.loads(self.m.execute(script, [index]))
                last = st
                uri = st.get("uri") or ""
                if (st.get("ok") and st.get("loading") is False and uri.startswith("http")
                        and (expect_substr is None or expect_substr in uri)):
                    return st
            except Exception as exc:
                last = {"error": str(exc)}
            time.sleep(0.15)
        return last or {"error": "timeout"}

    def stock_select(self, index):
        return self.m.execute("const i=arguments[0]; if(gBrowser.tabs[i]) gBrowser.selectedTab=gBrowser.tabs[i]; return 'ok'", [index])

    def navigate_current(self, url):
        if self.kind == "astra":
            script = """const url = arguments[0];
            const done = arguments[arguments.length - 1];
            (async () => {
              try {
                const r = await window.__astraHost.Navigation.loadURL({ request_id: 'stress', url });
                done(JSON.stringify(r));
              } catch (e) { done(JSON.stringify({ error: String(e) })); }
            })();"""
            raw = self.m.execute_async(script, [url])
            try:
                return json.loads(raw)
            except Exception:
                return {"raw": raw}
        script = """const url = arguments[0];
        const principal = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.selectedBrowser.fixupAndLoadURIString(url, { triggeringPrincipal: principal });
        return 'ok';"""
        return self.m.execute(script, [url])

    def setup(self, specs, inject_lag=False):
        if inject_lag:
            self.m.execute(INJECT_LAG)
        urls = []
        # The window already has exactly one tab. Land the first spec in it,
        # then create only the remaining tabs: tab counts stay comparable
        # between Astra and stock.
        first_url, first_meta = specs[0]
        first_state = None
        if first_url != "about:blank":
            expect = first_url.split("?")[0]
            if self.kind == "astra":
                self.tab_ids.append((self.astra_state().get("active") or ""))
                self.navigate_current(first_url)
                first_state = self.wait_astra_loaded(30, expect)
            else:
                self.navigate_current(first_url)
                first_state = self.stock_wait_loaded(0, 30, expect)
            if not first_state or first_state.get("error") or first_state.get("loading") is not False:
                self.errors.append(f"tab0 load: {json.dumps(first_state)[:200]}")
        urls.append({"url": first_url, "meta": first_meta,
                     "loaded": bool(first_state and first_state.get("loading") is False),
                     "state": first_state})
        for i, (url, meta) in enumerate(specs[1:], start=1):
            if url == "about:blank":
                urls.append({"url": url, "meta": meta, "loaded": True})
                continue
            expect = url.split("?")[0]
            if self.kind == "astra":
                r = self.astra_create_tab(url)
                if "error" in r:
                    self.errors.append(f"tab{i} create: {r['error']}")
                tab_id = r.get("astra_tab_id")
                if tab_id:
                    self.tab_ids.append(tab_id)
                st = self.wait_astra_loaded(30, expect)
            else:
                idx = self.stock_add_tab(url)
                # A background tab in stock 159 can be created lazily; select
                # it once so the page (and its muted video) actually starts,
                # exactly like Astra's foreground-created tab.
                self.stock_select(int(idx))
                st = self.stock_wait_loaded(int(idx), 30, expect)
            if not st or st.get("error") or st.get("loading") is not False:
                self.errors.append(f"tab{i} load: {json.dumps(st)[:200]}")
            urls.append({"url": url, "meta": meta, "loaded": bool(st and st.get("loading") is False), "state": st})
            time.sleep(0.35)
        # Put the first real page in front for the steady window.
        if self.kind == "astra" and self.tab_ids:
            self.astra_select_tab(self.tab_ids[0])
            self.wait_astra_loaded(15)
        elif self.kind == "stock" and len(urls) > 1:
            self.stock_select(0)
        return urls

    def astra_state(self):
        try:
            return json.loads(self.m.execute(ASTRA_STATE))
        except Exception as exc:
            return {"error": str(exc)}

    def tab_map(self):
        try:
            if self.kind == "astra":
                return json.loads(self.m.execute(TAB_MAP_ASTRA))
            return json.loads(self.m.execute(STOCK_TAB_MAP))
        except Exception as exc:
            return {"error": str(exc)}

    def screenshot(self, path):
        try:
            shot = self.m.cmd("WebDriver:TakeScreenshot", {})
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(base64.b64decode(shot["value"]))
            return True
        except Exception as exc:
            self.errors.append(f"screenshot: {exc}")
            return False

    def read_lag(self):
        try:
            return json.loads(self.m.execute(READ_LAG))
        except Exception:
            return None

    def animations(self):
        """Running CSS/Web animations at the end of the steady window.

        An always-running animation that is not visible is a common source of
        idle CPU/GPU; this records what the compositor is actually ticking.
        """
        try:
            return json.loads(self.m.execute("""return JSON.stringify((() => {
              const dump = (d) => {
                try {
                  return d.getAnimations().map((a) => ({
                    state: a.playState,
                    name: a.animationName || null,
                    target: (a.effect && a.effect.target
                      ? (a.effect.target.className || a.effect.target.tagName || '?') : null),
                    iter: a.effect ? a.effect.getTiming().iterations : null,
                  })).slice(0, 200);
                } catch (e) { return [{ error: String(e) }]; }
              };
              const f = document.querySelector('iframe[data-astra-app-frame]');
              const d = f && f.contentDocument;
              return { chrome: dump(document), app: d ? dump(d) : null };
            })())"""))
        except Exception as exc:
            return {"error": str(exc)}

    def force_active_docshell(self):
        """Diagnostic probe: mark the visible content browser's docshell active.

        A real tabbrowser does this on tab switch. Astra's custom stage only
        toggles its own attributes, so this A/B tests whether the 60 Hz cap is
        the missing docshell activation.
        """
        try:
            return json.loads(self.m.execute("""return JSON.stringify((() => {
              const b = document.querySelector('browser[data-astra-browser]');
              if (!b) return { ok: false, why: 'no-browser' };
              let before = null;
              try { before = b.docShellIsActive; } catch (e) {}
              try { b.docShellIsActive = true; } catch (e) { return { ok: false, why: String(e), before }; }
              let after = null;
              try { after = b.docShellIsActive; } catch (e) {}
              return { ok: true, before, after };
            })())"""))
        except Exception as exc:
            return {"ok": False, "why": str(exc)}

    def scroll_active_page(self):
        """Scroll the active content page over ~1 s in its own context."""
        try:
            self.m.cmd("Marionette:SetContext", {"value": "content"})
        except Exception as exc:
            return {"ok": False, "why": f"content context: {exc}", "ms": None}
        try:
            script = """const done = arguments[arguments.length - 1];
            const t0 = performance.now();
            const el = document.scrollingElement || document.documentElement;
            const max = Math.max(1, el.scrollHeight - innerHeight);
            let y = 0; let steps = 0;
            (function step() {
              y = Math.min(max, y + Math.max(40, max / 24));
              scrollTo(0, y);
              steps += 1;
              if (y < max && steps < 40) requestAnimationFrame(step);
              else done(JSON.stringify({ ok: true, ms: Math.round((performance.now() - t0) * 10) / 10,
                                         scrolled: Math.round(y), max: Math.round(max), steps }));
            })();"""
            raw = self.m.execute_async(script)
            return json.loads(raw)
        except Exception as exc:
            return {"ok": False, "why": str(exc), "ms": None}
        finally:
            try:
                self.m.cmd("Marionette:SetContext", {"value": "chrome"})
            except Exception:
                pass

    def count_tabs(self):
        if self.kind == "astra":
            return len(self.astra_state().get("tabs") or [])
        try:
            return int(self.m.execute("return gBrowser.tabs.length"))
        except Exception:
            return -1

    def close(self):
        try:
            if getattr(self, "_focus_stop", None):
                self._focus_stop.set()
        except Exception:
            pass
        try:
            if self.m:
                self.m.close()
        except Exception:
            pass
        if not self.proc:
            return
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except Exception:
            try:
                self.proc.terminate()
            except Exception:
                pass
        try:
            self.proc.wait(timeout=15)
        except Exception:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except Exception:
                pass


# --------------------------------------------------------------------------
# UI tour
# --------------------------------------------------------------------------
def ui_action(run, action, arg=None):
    script = """const action = arguments[0];
    const arg = arguments[1];
    const done = arguments[arguments.length - 1];
    const t0 = performance.now();
    const d = (() => { try { const f = document.querySelector('iframe[data-astra-app-frame]'); return f && f.contentDocument; } catch (e) { return null; } })();
    const q = (s) => d && d.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        try { if (fn()) return true; } catch (e) {}
        await sleep(16);
      }
      return false;
    };
    const tabs = () => d ? [...d.querySelectorAll('[data-astra-tab-id]')] : [];
    const shell = () => q('.shell');
    (async () => {
      if (!d) { done(JSON.stringify({ ok: false, why: 'no-app-doc', ms: 0 })); return; }
      try {
        let ok = false;
        if (action === 'newtab') {
          const before = tabs().length;
          const b = q('button.new-tab') || q('button.space-new-tab');
          if (b) b.click();
          ok = await waitFor(() => tabs().length === before + 1, 6000);
        } else if (action === 'navigate') {
          const input = q('.address-field input');
          const form = input && input.closest('form');
          if (input && form) {
            input.focus();
            input.value = arg;
            input.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
            form.dispatchEvent(new d.defaultView.SubmitEvent('submit', { bubbles: true, cancelable: true }));
          }
          ok = await waitFor(() => {
            const b = document.querySelector('browser[data-astra-browser]');
            return !!b && !b.webProgress?.isLoadingDocument && String(b.currentURI?.spec || '').includes('/static.html');
          }, 20000);
        } else if (action === 'switch') {
          const rows = tabs();
          const row = rows[Number(arg)];
          if (!row) { done(JSON.stringify({ ok: false, why: 'no-row', ms: performance.now() - t0 })); return; }
          const id = row.getAttribute('data-astra-tab-id');
          const open = row.querySelector('button.tab-open') || row;
          open.click();
          ok = await waitFor(() => {
            const b = document.querySelector('browser[data-astra-browser]');
            return shell()?.getAttribute('data-astra-active-tab') === id
              && !!b && !b.webProgress?.isLoadingDocument;
          }, 5000);
        } else if (action === 'sidebar') {
          const b = [...d.querySelectorAll('header button')].find((x) => /toggle sidebar/i.test(x.getAttribute('aria-label') || ''));
          if (b) { b.click(); await sleep(400); b.click(); await sleep(400); ok = true; }
        } else if (action === 'work') {
          const radios = [...d.querySelectorAll('[role="radio"]')];
          const w = radios.find((x) => (x.textContent || '').trim() === 'Work');
          if (w) { w.click(); ok = await waitFor(() => shell()?.getAttribute('data-astra-surface') === 'work', 5000); }
        } else if (action === 'settings') {
          const c = q('.shelf .case');
          if (c) { c.click(); await sleep(350); }
          const row = [...d.querySelectorAll('[role="menuitem"]')].find((x) => /settings/i.test(x.textContent || ''));
          if (row) { row.click(); await sleep(700); ok = !!q('[data-page="settings"]') || /settings/i.test(q('.browser-sidebar')?.textContent || ''); }
        } else if (action === 'scroll') {
          const main = q('main') || q('#astra-stage');
          if (main) { main.scrollTop = Math.min(main.scrollHeight || 2000, 1500); await sleep(300); ok = true; }
        }
        const alerts = [...d.querySelectorAll('[role=alert]')].map((a) => (a.textContent || '').trim()).filter(Boolean);
        done(JSON.stringify({
          ok, ms: Math.round((performance.now() - t0) * 10) / 10, alerts: alerts.slice(0, 3),
          diag: {
            ids: tabs().map((r) => r.getAttribute('data-astra-tab-id')),
            buttons: tabs().map((r) => !!r.querySelector('button.tab-open')),
            active: shell() ? shell().getAttribute('data-astra-active-tab') : null,
            surface: shell() ? shell().getAttribute('data-astra-surface') : null,
          },
        }));
      } catch (e) {
        done(JSON.stringify({ ok: false, why: String(e), ms: Math.round((performance.now() - t0) * 10) / 10 }));
      }
    })();"""
    try:
        raw = run.m.execute_async(script, [action, arg])
        return json.loads(raw)
    except Exception as exc:
        return {"ok": False, "why": str(exc), "ms": None}


def run_ui_tour(run):
    actions = []
    def add(name, arg=None):
        r = ui_action(run, name, arg)
        label = f"{name}:{arg}" if arg is not None else name
        actions.append({"action": label, **r})
        return r

    add("newtab")
    add("navigate", "http://127.0.0.1:%d/static.html?id=ui-nav&kind=static" % PORTS[0])
    for i in range(0, 6):
        add("switch", i)
        time.sleep(0.4)
    add("sidebar")
    add("work")
    add("settings")
    return actions


def run_ui_tour_stock(run):
    """Native-UI equivalent: the same tab operations, no Astra selectors."""
    actions = []
    script = """const action = arguments[0], arg = arguments[1];
    const t0 = performance.now();
    try {
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      if (action === 'newtab') {
        const t = gBrowser.addTab('about:blank', { triggeringPrincipal: principal, skipAnimation: true });
        gBrowser.selectedTab = t;
      } else if (action === 'navigate') {
        gBrowser.selectedBrowser.fixupAndLoadURIString(arg, { triggeringPrincipal: principal });
      } else if (action === 'switch') {
        const t = gBrowser.tabs[Number(arg)];
        if (!t) throw new Error('no tab');
        gBrowser.selectedTab = t;
      } else if (action === 'settings') {
        gBrowser.addTab('about:preferences', { triggeringPrincipal: principal, skipAnimation: true });
      }
      return JSON.stringify({ ok: true, ms: Math.round((performance.now() - t0) * 10) / 10,
                              tabs: gBrowser.tabs.length, index: gBrowser.selectedTab._tPos });
    } catch (e) {
      return JSON.stringify({ ok: false, why: String(e), ms: Math.round((performance.now() - t0) * 10) / 10 });
    }"""
    def add(name, arg=None):
        try:
            r = json.loads(run.m.execute(script, [name, arg]))
        except Exception as exc:
            r = {"ok": False, "why": str(exc), "ms": None}
        time.sleep(0.5)
        actions.append({"action": f"{name}:{arg}" if arg is not None else name, **r})
    add("newtab")
    add("navigate", "http://127.0.0.1:%d/static.html?id=ui-nav&kind=static" % PORTS[0])
    for i in range(0, 6):
        add("switch", i)
    add("settings")
    for i in (5, 4, 3, 2, 1, 0):
        add("switch", i)
    return actions


# --------------------------------------------------------------------------
# Page-report analysis
# --------------------------------------------------------------------------
def load_reports(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows


def analyze_reports(rows, active_id="t0"):
    pages = {}
    for r in rows:
        pid = str(r.get("id") or "?")
        p = pages.setdefault(pid, {
            "id": pid, "kind": r.get("kind"), "reports": 0, "fps": [],
            "visible_reports": 0, "hidden_reports": 0, "video": [], "gl": None,
            "href": r.get("href"),
        })
        p["reports"] += 1
        if r.get("hidden"):
            p["hidden_reports"] += 1
        else:
            p["visible_reports"] += 1
        if isinstance(r.get("fps"), (int, float)):
            p["fps"].append(r["fps"])
        if r.get("video"):
            p["video"].append({"t": r.get("t"), "server": r.get("_server_t"),
                               "v": r["video"], "hidden": r.get("hidden")})
        if r.get("gl") and not f"'{r['gl']}'" == "'None'":
            p["gl"] = r["gl"]
    out = []
    for p in pages.values():
        fps = [f for f in p["fps"] if isinstance(f, (int, float))]
        video_summary = []
        if p["video"]:
            first = p["video"][0]
            last = p["video"][-1]
            for idx, v0 in enumerate(first["v"]):
                if idx >= len(last["v"]):
                    continue
                v1 = last["v"][idx]
                decoded0 = v0.get("decoded") or 0
                decoded1 = v1.get("decoded") or 0
                t0 = v0.get("t") if v0.get("t") is not None else 0
                t1 = v1.get("t") if v1.get("t") is not None else 0
                video_summary.append({
                    "src": v1.get("src"),
                    "start_s": t0,
                    "end_s": t1,
                    "advanced_s": round(t1 - t0, 2),
                    "decoded": max(0, decoded1 - decoded0),
                    "dropped": max(0, (v1.get("dropped") or 0) - (v0.get("dropped") or 0)),
                    "w": v1.get("width"), "h": v1.get("height"),
                    "paused_at_end": v1.get("paused"),
                })
        out.append({
            "id": p["id"], "kind": p["kind"], "reports": p["reports"],
            "href": p["href"],
            "fps_mean": round(statistics.fmean(fps), 1) if fps else None,
            "fps_max": round(max(fps), 1) if fps else None,
            "fps_min": round(min(fps), 1) if fps else None,
            "visible_reports": p["visible_reports"],
            "hidden_reports": p["hidden_reports"],
            # A background tab whose rAF is throttled but whose visibility API
            # still says "visible": pages that pause on visibilitychange keep
            # working in the background. The active page is t0 by construction
            # (the harness selects it before the steady window), except in the
            # UI tour where the foreground changes by design.
            "visibility_mismatch": bool(
                active_id and p["id"] != active_id and p["reports"] >= 3
                and p["hidden_reports"] == 0
            ),
            "video": video_summary,
            "gl": p["gl"],
        })
    out.sort(key=lambda r: r["id"])
    return out


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------
def fmt(x, unit="", nd=1):
    if x is None:
        return "—"
    if isinstance(x, float):
        return f"{x:.{nd}f}{unit}"
    return f"{x}{unit}"


def per_phase(summary, phase):
    ph = (summary.get("phases") or {}).get(phase) or {}
    return ph


def build_run_report(scenario_name, scenario, run, summary, pages, ui_actions, env, checks):
    desc = scenario["desc"]
    label = f"{run.kind} · {scenario_name} · r{run.repeat}"
    lines = []
    lines.append(f"# Stress run — {label}")
    lines.append("")
    lines.append(f"_Generated automatically at {time.strftime('%Y-%m-%d %H:%M:%S')}._")
    lines.append("")
    lines.append(desc)
    lines.append("")
    if env:
        lines.append("**Environment at launch**")
        lines.append("")
        lines.append("| Fact | Value |")
        lines.append("|---|---|")
        for k, v in env.items():
            if isinstance(v, (dict, list)):
                v = json.dumps(v)
            lines.append(f"| {k} | {v} |")
        lines.append("")
    lines.append("**Cold start / setup**")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|---|---|")
    for k, v in run.timings.items():
        if isinstance(v, (dict, list)):
            v = json.dumps(v)
        lines.append(f"| {k} | {v} |")
    lines.append("")
    steady = per_phase(summary, "steady")
    def row(name, key, unit="", nd=1):
        s = steady.get(key) or {}
        return (f"| {name} | {fmt(s.get('mean'), unit, nd)} | {fmt(s.get('max'), unit, nd)} "
                f"| {fmt(s.get('p95'), unit, nd)} | {s.get('n', 0)} |")
    lines.append("**Steady window — whole browser tree**")
    lines.append("")
    lines.append("| Metric | mean | max | p95 | samples |")
    lines.append("|---|---|---|---|---|")
    lines.append(row("CPU, % of one hardware thread (100 = 1 core)", "cpu_core", "%", 1))
    lines.append(row("CPU, % of the whole machine", "cpu_system_pct", "%", 1))
    lines.append(row("PSS (proportional RAM)", "pss_mb", " MiB", 1))
    lines.append(row("Private memory", "private_mb", " MiB", 1))
    lines.append(row("Swap used", "swap_mb", " MiB", 1))
    lines.append(row("GPU render engine (of one engine)", "gpu_render_pct", "%", 1))
    lines.append(row("GPU video engine (hw decode)", "gpu_video_pct", "%", 1))
    lines.append(row("GPU memory", "gpu_mem_mb", " MiB", 1))
    lines.append(row("iGPU busy (system, rc6)", "igpu_busy_pct", "%", 1))
    lines.append(row("System CPU busy", "sys_cpu_busy_pct", "%", 1))
    lines.append(row("Machine RAM available", "sys_mem_available_mb", " MiB", 1))
    lines.append(row("Processes", "procs", "", 0))
    lines.append(row("Threads", "threads", "", 0))
    lines.append("")
    amb = env.get("igpu_busy_pct")
    steady_igpu = (steady.get("igpu_busy_pct") or {}).get("mean")
    if amb is not None and steady_igpu is not None:
        lines.append(f"Ambient iGPU before launch: **{fmt(amb, '%')}** · browser steady iGPU: "
                     f"**{fmt(steady_igpu, '%')}** · browser-attributed GPU share is the per-process "
                     f"DRM render figure above, not the system rc6 counter.")
        lines.append("")
    lines.append(f"Peak PSS over the whole run: **{summary.get('peak_pss_mb')} MiB** · "
                 f"peak processes **{summary.get('peak_procs')}** · peak threads **{summary.get('peak_threads')}**.")
    lines.append("")
    lines.append("**Where it went — by process kind (steady mean)**")
    lines.append("")
    lines.append("| Kind | Processes | CPU % of one thread | CPU % machine | PSS MiB | GPU render % | GPU video % |")
    lines.append("|---|---|---|---|---|---|---|")
    kinds = steady.get("by_kind") or {}
    def km(k, field):
        d = kinds.get(k) or {}
        s = d.get(field) or {}
        return s.get("mean")
    for k in sorted(kinds, key=lambda k: -(km(k, "cpu_core") or 0)):
        c = km(k, "cpu_core")
        p = km(k, "pss_mb")
        pct_machine = (c / (os.cpu_count() or 1)) if c is not None else None
        lines.append(f"| {k} | {fmt(km(k, 'procs'), '', 0)} | {fmt(c, '', 1)} | {fmt(pct_machine, '%', 1)} "
                     f"| {fmt(p, '', 1)} | {fmt(km(k, 'gpu_render_pct'), '', 1)} | {fmt(km(k, 'gpu_video_pct'), '', 1)} |")
    lines.append("")
    # Top processes at the last steady sample
    samples = []
    if os.path.exists(os.path.join(run.outdir, "samples.jsonl")):
        with open(os.path.join(run.outdir, "samples.jsonl"), "r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    s = json.loads(line)
                except Exception:
                    continue
                if s.get("phase") == "steady" and "procs" in s:
                    samples.append(s)
    if samples:
        last = samples[-1]
        procs = list(last["procs"].values())
        lines.append("**Top processes (last steady sample)**")
        lines.append("")
        lines.append("| PID | Kind | Command | CPU %core | PSS MiB | GPU render % | GPU video % | Threads |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for p in sorted(procs, key=lambda p: -(p.get("cpu_pct_core") or 0))[:8]:
            lines.append(f"| {p['pid']} | {p['kind']} | {p['comm']} | {fmt(p.get('cpu_pct_core'), '', 1)} "
                         f"| {fmt(p.get('pss_mb'), '', 1)} | {fmt(p.get('gpu_render_pct'), '', 1)} "
                         f"| {fmt(p.get('gpu_video_pct'), '', 1)} | {p.get('threads', '')} |")
        lines.append("")
        lines.append("| PID | Kind | Command | CPU %core | PSS MiB | GPU render % | GPU video % | Threads |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for p in sorted(procs, key=lambda p: -(p.get("pss_mb") or 0))[:5]:
            lines.append(f"| {p['pid']} | {p['kind']} | {p['comm']} | {fmt(p.get('cpu_pct_core'), '', 1)} "
                         f"| {fmt(p.get('pss_mb'), '', 1)} | {fmt(p.get('gpu_render_pct'), '', 1)} "
                         f"| {fmt(p.get('gpu_video_pct'), '', 1)} | {p.get('threads', '')} |")
        lines.append("")
    if pages:
        lines.append("**Page heartbeats (rAF / video / WebGL)**")
        lines.append("")
        lines.append("| Page | Reports | Visible/Hidden | FPS mean | FPS min | Video advanced | Decoded frames | Dropped | Visibility API | GL renderer |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        for p in pages:
            vids = p.get("video") or []
            adv = ", ".join(f"{v['advanced_s']:.1f}s" for v in vids) or "—"
            dec = ", ".join(str(v["decoded"]) for v in vids) or "—"
            drop = ", ".join(str(v["dropped"]) for v in vids) or "—"
            gl = (p.get("gl") or {}).get("renderer") if p.get("gl") else None
            vis = "MISMATCH: says visible, rAF throttled" if p.get("visibility_mismatch") else "ok"
            lines.append(f"| {p['id']} | {p['reports']} | {p['visible_reports']}/{p['hidden_reports']} "
                         f"| {fmt(p.get('fps_mean'), '', 1)} | {fmt(p.get('fps_min'), '', 1)} | {adv} | {dec} | {drop} | {vis} | {gl or '—'} |")
        lines.append("")
        mism = [p["id"] for p in pages if p.get("visibility_mismatch")]
        if mism:
            lines.append(f"**Visibility finding:** {len(mism)} background page(s) still report "
                         f"`document.visibilityState = visible` while rAF is throttled to <10/s: "
                         f"{', '.join(mism)}. Timers and JS work that only stop on "
                         f"`visibilitychange` are therefore still running in the background.")
            lines.append("")
    if ui_actions:
        lines.append("**UI actions**")
        lines.append("")
        lines.append("| Action | OK | Milliseconds | Alerts |")
        lines.append("|---|---|---|---|")
        for a in ui_actions:
            lines.append(f"| {a.get('action')} | {a.get('ok')} | {fmt(a.get('ms'), '', 1)} | "
                         f"{json.dumps(a.get('alerts')) if a.get('alerts') else '—'} |")
        lines.append("")
    lines.append("**Checks**")
    lines.append("")
    for c in checks:
        lines.append(f"- {'PASS' if c['ok'] else 'FAIL'} — {c['name']}" + (f" ({c['detail']})" if c.get("detail") else ""))
    lines.append("")
    verdict = "PASS" if all(c["ok"] for c in checks) else "FAIL"
    lines.append(f"**Verdict: {verdict}**")
    lines.append("")
    return "\n".join(lines), verdict


def append_observation(run_id, report_md, scenario_name, run, summary, verdict):
    header = "# Astra stress observations\n\n" if not os.path.exists(OBSERVATIONS) else ""
    text = _read(OBSERVATIONS, "") or ""
    marker = f"<!-- RUN:{run_id} -->"
    steady = per_phase(summary, "steady")
    def mean(key):
        return (steady.get(key) or {}).get("mean")
    brief = [
        marker,
        f"## {run.kind} · {scenario_name} · repeat {run.repeat} — {verdict}",
        "",
        f"- Cold start: spawn→Marionette {run.timings.get('spawn_to_marionette_ms')} ms, "
        f"spawn→UI ready {run.timings.get('spawn_to_ui_ready_ms')} ms",
        f"- Steady CPU {fmt((mean('cpu_core') or 0) / 100.0, '', 2)} cores "
        f"({fmt(mean('cpu_system_pct'), '%')} of the machine), "
        f"PSS {fmt(mean('pss_mb'), ' MiB')}, private {fmt(mean('private_mb'), ' MiB')}",
        f"- GPU render {fmt(mean('gpu_render_pct'), '%')}, video {fmt(mean('gpu_video_pct'), '%')}, "
        f"GPU memory {fmt(mean('gpu_mem_mb'), ' MiB')}, iGPU busy {fmt(mean('igpu_busy_pct'), '%')}",
        f"- Processes {fmt(mean('procs'), '', 0)}, threads {fmt(mean('threads'), '', 0)}; "
        f"peak PSS {summary.get('peak_pss_mb')} MiB",
        f"- Full report: `{os.path.relpath(os.path.join(run.outdir, 'REPORT.md'), ROOT)}`",
        "",
    ]
    block = "\n".join(brief)
    if marker in text:
        before, rest = text.split(marker, 1)
        # drop the old block up to the next marker or EOF
        nxt = rest.find("<!-- RUN:")
        after = rest[nxt:] if nxt >= 0 else ""
        text = before + block + "\n" + after
    else:
        if not text:
            text = header + (
                "Every block below is one measured run. Raw samples, summaries, page "
                "heartbeats and screenshots live in `out/stress-*/<run>/`.\n\n"
                "Method: headed browser, fresh profile, local loopback fixtures, one "
                "sample per 0.5 s of CPU + PSS + DRM engine counters + iGPU rc6 + dGPU. "
                "CPU cores = one fully busy hardware thread. GPU render % = one render "
                "engine fully busy; values can exceed 100% when several DRM clients "
                "share the engine.\n\n"
            )
        text += block + "\n"
    with open(OBSERVATIONS, "w", encoding="utf-8") as fh:
        fh.write(text)


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------
def ambient(duration=4.0):
    a = system_cpu()
    rc6 = None
    intel = find_intel_card()
    if intel and intel["rc6"]:
        rc6 = _int(_read(intel["rc6"], "0"))
    t0 = time.monotonic()
    time.sleep(duration)
    b = system_cpu()
    dt = time.monotonic() - t0
    mem = system_mem()
    rc6b = _int(_read(intel["rc6"], "0")) if intel and intel["rc6"] else None
    out = {
        "seconds": round(dt, 1),
        "cpu_busy_pct": round(100.0 * (b["busy"] - a["busy"]) / max(1, b["total"] - a["total"]), 1),
        "mem_available_mb": round(mem.get("MemAvailable", 0) / 1024.0, 1),
        "swap_used_mb": round((mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)) / 1024.0, 1),
        "load": loadavg(),
        "igpu_busy_pct": round(max(0.0, min(100.0, 100.0 * (1.0 - (rc6b - rc6) / (dt * 1000.0)))), 1) if rc6 is not None and rc6b is not None else None,
        "cpu_count": os.cpu_count(),
    }
    return out


def start_servers(run_dir):
    report = os.path.join(run_dir, "reports.jsonl")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "stress_server.py"),
         "--root", FIXTURES, "--report", report, "--ports", *[str(p) for p in PORTS]],
        stdout=open(os.path.join(run_dir, "server.log"), "wb"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", PORTS[0]), timeout=0.5):
                return proc, report
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("fixture servers did not start")


def stop_servers(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass


def run_one(kind, scenario_name, scenario, outroot, repeat, index):
    run_id = f"{kind}-{scenario_name}-r{repeat}"
    run_dir = os.path.join(outroot, run_id)
    os.makedirs(run_dir, exist_ok=True)
    profile = os.path.join(outroot, "profiles", run_id)
    shutil.rmtree(profile, ignore_errors=True)
    port = 2830 + index
    env = ambient(4.0)
    env["binary"] = ASTRA_BIN if kind == "astra" else STOCK_BIN
    env["scenario_tabs"] = len(scenario["tabs"])
    if kind == "stock":
        try:
            env["stock_version"] = subprocess.run([STOCK_BIN, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            env["stock_version"] = "?"
    else:
        env["astra_binary_mtime"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(ASTRA_BIN)))

    servers, report_path = start_servers(run_dir)
    run = BrowserRun(kind, run_dir, profile, port, repeat)
    sampler = Sampler(0, run_dir, interval=0.5, label=f"{kind}-{scenario_name}")
    checks = []
    ui_actions = []
    try:
        run.launch(sampler)
        run.connect(sampler)
        ready = run.wait_ready(sampler)
        checks.append({"ok": ready, "name": "UI/chrome ready", "detail": json.dumps(run.timings.get("ready_state"))[:180]})
        run.screenshot(os.path.join(run_dir, "shots", "00-ready.png"))

        sampler.mark("load-start")
        specs = tab_urls(scenario, PORTS)
        loaded = run.setup(specs, inject_lag=bool(scenario.get("ui")))
        if os.environ.get("ASTRA_STRESS_DOCSHELL") == "1" and kind == "astra":
            run.timings["docshell_probe"] = run.force_active_docshell()
            sampler.mark("docshell")
        sampler.mark("tabs-ready")
        time.sleep(2.0)
        sampler.mark("settle")

        # UI tour runs inside the steady window so its cost is in the sample.
        if scenario.get("ui"):
            sampler.mark("steady")
            ui_actions = run_ui_tour(run) if kind == "astra" else run_ui_tour_stock(run)
            run.screenshot(os.path.join(run_dir, "shots", "10-ui-tour.png"))
            time.sleep(max(0, scenario.get("steady", 30) - sum((a.get("ms") or 0) for a in ui_actions) / 1000.0))
        else:
            sampler.mark("steady")
            time.sleep(scenario.get("steady", 25))
        sampler.mark("steady-end")

        lag = run.read_lag()
        animations = run.animations()
        state = run.astra_state() if kind == "astra" else None
        tabmap = run.tab_map()
        with open(os.path.join(run_dir, "tabs.json"), "w", encoding="utf-8") as fh:
            json.dump(tabmap, fh, indent=2)
        run.screenshot(os.path.join(run_dir, "shots", "99-final.png"))

        # Short thread-level profile while the steady state is still live.
        threads = sampler.thread_profile(1.2)
        sampler.mark("teardown")
        sampler.stop()
        summary = sampler.finalize(run_dir, {
            "kind": kind,
            "scenario": scenario_name,
            "repeat": repeat,
            "timings": run.timings,
            "ambient": env,
            "threads": threads,
            "lag": lag,
            "state": state,
            "animations": animations,
            "tabmap": tabmap,
            "errors": run.errors,
        })
        stop_servers(servers)
        servers = None

        rows = load_reports(report_path)
        pages = analyze_reports(rows, active_id=(None if scenario.get("ui") else "t0"))
        if kind == "stock":
            # stock's content pages are still covered by the same beacons
            pass

        expected = len(scenario["tabs"])
        tab_count = run.count_tabs()
        if scenario.get("ui"):
            checks.append({"ok": tab_count >= expected, "name": "base tabs still open",
                           "detail": f"{tab_count}/{expected}"})
        else:
            checks.append({"ok": tab_count == expected, "name": "expected tab count",
                           "detail": f"{tab_count}/{expected}"})
        if scenario.get("expect_video"):
            playing = 0
            for p in pages:
                for v in p.get("video") or []:
                    if (v.get("advanced_s") or 0) >= 2.0:
                        playing += 1
            checks.append({"ok": playing >= scenario["expect_video"],
                           "name": "videos actually played",
                           "detail": f"{playing}/{scenario['expect_video']} advanced ≥2 s"})
        if scenario.get("expect_gl"):
            gl_ok = any((p.get("gl") or {}).get("renderer") for p in pages)
            fps_ok = any((p.get("fps_mean") or 0) > 5 for p in pages)
            checks.append({"ok": gl_ok and fps_ok, "name": "WebGL rendered frames",
                           "detail": f"gl={gl_ok} fps>5={fps_ok}"})
        if run.errors:
            checks.append({"ok": False, "name": "no driver errors", "detail": "; ".join(run.errors[:3])})
        else:
            checks.append({"ok": True, "name": "no driver errors"})
        if kind == "astra" and state:
            checks.append({"ok": not (state.get("alerts") or []), "name": "no UI alert",
                           "detail": json.dumps(state.get("alerts") or [])[:160]})
        if ui_actions:
            bad = [a for a in ui_actions if not a.get("ok")]
            checks.append({"ok": not bad, "name": "UI tour actions",
                           "detail": json.dumps([b.get("action") for b in bad])[:180]})

        with open(os.path.join(run_dir, "ui_actions.json"), "w", encoding="utf-8") as fh:
            json.dump(ui_actions, fh, indent=2)
        with open(os.path.join(run_dir, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "run_id": run_id, "browser": kind, "scenario": scenario_name,
                "repeat": repeat, "env": env, "timings": run.timings,
                "checks": checks, "pages": pages, "threads": threads,
                "state": state, "lag": lag, "animations": animations,
            }, fh, indent=2)

        report_md, verdict = build_run_report(scenario_name, scenario, run, summary, pages, ui_actions, env, checks)
        with open(os.path.join(run_dir, "REPORT.md"), "w", encoding="utf-8") as fh:
            fh.write(report_md)
        append_observation(run_id, report_md, scenario_name, run, summary, verdict)
        _cpu = per_phase(summary, "steady").get("cpu_core", {}).get("mean")
        print(f"[{run_id}] {verdict}: cpu {((_cpu or 0)/100):.2f} cores, "
              f"pss {per_phase(summary, 'steady').get('pss_mb', {}).get('mean')} MiB, "
              f"gpu {per_phase(summary, 'steady').get('gpu_render_pct', {}).get('mean')}%", flush=True)
        return {"run_id": run_id, "dir": run_dir, "verdict": verdict, "summary": summary,
                "pages": pages, "checks": checks, "timings": run.timings}
    finally:
        try:
            sampler.stop()
        except Exception:
            pass
        run.close()
        if servers:
            stop_servers(servers)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", choices=["astra", "stock", "both"], default="both")
    ap.add_argument("--scenario", default="all")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--out", default=None)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        for name, sc in SCENARIOS.items():
            print(f"{name:16s} {sc['desc']}")
        return 0
    if args.scenario == "all":
        names = list(SCENARIOS)
    else:
        names = [n.strip() for n in args.scenario.split(",") if n.strip()]
        bad = [n for n in names if n not in SCENARIOS]
        if bad:
            print("unknown scenarios: " + ", ".join(bad))
            return 2
    if args.browser == "astra" and not os.path.exists(ASTRA_BIN):
        print(f"SKIP no Astra binary at {ASTRA_BIN}")
        return 2
    outroot = args.out or os.path.join(ROOT, "out", "stress-" + time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(outroot, exist_ok=True)
    index = []
    idx = 0
    for repeat in range(1, args.repeat + 1):
        for name in names:
            sc = SCENARIOS[name]
            for kind in (["astra", "stock"] if args.browser == "both" else [args.browser]):
                idx += 1
                print(f"=== {kind} · {name} · repeat {repeat} ===", flush=True)
                try:
                    res = run_one(kind, name, sc, outroot, repeat, idx)
                    index.append({k: v for k, v in res.items() if k != "summary"})
                except Exception as exc:
                    import traceback
                    traceback.print_exc()
                    index.append({"run_id": f"{kind}-{name}-r{repeat}", "verdict": "ERROR",
                                  "error": f"{type(exc).__name__}: {exc}"})
    with open(os.path.join(outroot, "runs.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2)
    print(f"matrix written to {outroot}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
