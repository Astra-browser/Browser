#!/usr/bin/env python3
"""One-off probe: what burns CPU for ~15 s after an Astra page loads?"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, HERE)
import run_matrix as R
from profiler import Sampler

OUT = os.path.join(ROOT, "out", "burn-probe")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
profile = os.path.join(OUT, "profile")
servers, report = R.start_servers(OUT)
run = R.BrowserRun("astra", OUT, profile, 2840, 1)
sampler = Sampler(0, OUT)
try:
    run.launch(sampler)
    run.connect(sampler)
    run.wait_ready(sampler)
    run.navigate_current(f"http://127.0.0.1:{R.PORTS[0]}/blank.html?id=burn&kind=blank")
    run.wait_active_page(20)
    t0 = time.monotonic()
    script = """const done = arguments[arguments.length - 1];
    (async () => {
      const out = (() => {
        const f = document.querySelector('iframe[data-astra-app-frame]');
        const d = f && f.contentDocument;
        const dump = (doc) => {
          try {
            return doc.getAnimations().map((a) => ({
              state: a.playState,
              name: a.animationName || null,
              target: (a.effect && a.effect.target
                ? (a.effect.target.className || a.effect.target.tagName || '?') : null),
              iter: a.effect ? a.effect.getTiming().iterations : null,
            }));
          } catch (e) { return [{ error: String(e) }]; }
        };
        const candidates = d ? [...d.querySelectorAll('[class*=skeleton],[class*=loading],[class*=spinner],[aria-busy=true],[data-loading]')]
          .map((el) => ({
            tag: el.tagName,
            cls: String(el.className).slice(0, 100),
            display: getComputedStyle(el).display,
            opacity: getComputedStyle(el).opacity,
            anim: getComputedStyle(el).animationName,
            dur: getComputedStyle(el).animationDuration,
          })).slice(0, 12) : [];
        return {
          chrome: dump(document),
          app: d ? dump(d) : null,
          candidates,
          appTitle: d ? d.title : null,
          surface: d ? d.querySelector('.shell')?.getAttribute('data-astra-surface') : null,
          active: d ? d.querySelector('.shell')?.getAttribute('data-astra-active-tab') : null,
        };
      })();
      let tabs = null;
      try {
        const r = await window.__astraHost.Tabs.list({ request_id: 'burn' });
        tabs = (r.tabs || []).map((t) => ({ id: t.astra_tab_id, loading: t.loading, url: t.url, discarded: t.discarded }));
      } catch (e) { tabs = String(e); }
      done(JSON.stringify({ ...out, tabs }));
    })();"""
    for target in (2, 5, 8, 11, 14, 17, 20, 23, 26):
        while time.monotonic() - t0 < target:
            time.sleep(0.1)
        try:
            data = json.loads(run.m.execute_async(script))
        except Exception as exc:
            data = {"error": str(exc)}
        # CPU from the sampler thread's latest completed 0.5 s window
        cpu = sampler.samples[-1] if sampler.samples else {"browser": {}}
        b = cpu["browser"]
        print(f"\n=== t+{target}s cpu={b.get('cpu_pct_core')}% gpu={b.get('gpu_render_pct')}% pss={b.get('pss_mb')} procs={b.get('procs')} ===")
        print("anims chrome:", data.get("chrome"))
        print("anims app:", data.get("app"))
        print("candidates:", json.dumps(data.get("candidates"))[:1200])
        print("tabs:", data.get("tabs"))
finally:
    sampler.stop()
    run.close()
    R.stop_servers(servers)
    print("done")
