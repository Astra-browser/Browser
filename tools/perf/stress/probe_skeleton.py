#!/usr/bin/env python3
"""One-off A/B: does pausing the post-load skeleton animations remove the burn?"""
import json
import os
import shutil
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, HERE)
import run_matrix as R
from profiler import Sampler

OUT = os.path.join(ROOT, "out", "skeleton-probe")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
profile = os.path.join(OUT, "profile")
servers, report = R.start_servers(OUT)
run = R.BrowserRun("astra", OUT, profile, 2841, 1)
sampler = Sampler(0, OUT)


def cpu(seconds=2.0):
    time.sleep(seconds)
    rows = sampler.samples[-6:]
    return {
        "cpu": round(statistics.fmean([r["browser"]["cpu_pct_core"] or 0 for r in rows]), 1),
        "gpu": round(statistics.fmean([r["browser"]["gpu_render_pct"] or 0 for r in rows]), 1),
        "pss": round(statistics.fmean([r["browser"]["pss_mb"] or 0 for r in rows]), 1),
    }


def focus():
    try:
        import subprocess
        subprocess.run(["hyprctl", "eval",
                        f"local w=hl.get_window('pid:{run.proc.pid}'); if w then hl.dispatch(hl.dsp.focus({{window=w}})) end; return 'ok'"],
                       capture_output=True, timeout=5)
    except Exception:
        pass
    time.sleep(0.3)


def anim_state():
    raw = run.m.execute("""return JSON.stringify((() => {
      const f = document.querySelector('iframe[data-astra-app-frame]');
      const d = f && f.contentDocument;
      return {
        focus: document.hasFocus(),
        visibility: document.visibilityState,
        chromeAnims: document.getAnimations().map((a) => a.animationName || '?'),
        appAnims: d ? d.getAnimations().map((a) => a.animationName || '?') : [],
      };
    })())""")
    return json.loads(raw)


def pause_anims(pause):
    run.m.execute("""const p = arguments[0];
      for (const a of document.getAnimations()) { try { p ? a.pause() : a.play(); } catch (e) {} }
      const f = document.querySelector('iframe[data-astra-app-frame]');
      const d = f && f.contentDocument;
      if (d) for (const a of d.getAnimations()) { try { p ? a.pause() : a.play(); } catch (e) {} }
      return 'ok';""", [pause])


try:
    run.launch(sampler)
    run.connect(sampler)
    run.wait_ready(sampler)
    run.navigate_current(f"http://127.0.0.1:{R.PORTS[0]}/blank.html?id=skel&kind=blank")
    run.wait_active_page(20)
    focus()
    print("state:", json.dumps(anim_state()))
    print("A normal     :", cpu(2.5))
    print("state:", json.dumps(anim_state()))
    pause_anims(True)
    print("B paused     :", cpu(2.5))
    print("state:", json.dumps(anim_state()))
    pause_anims(False)
    focus()
    print("C resumed    :", cpu(2.5))
    print("state:", json.dumps(anim_state()))
    pause_anims(True)
    print("D paused     :", cpu(2.5))
    print("state:", json.dumps(anim_state()))
finally:
    sampler.stop()
    run.close()
    R.stop_servers(servers)
    print("done")
