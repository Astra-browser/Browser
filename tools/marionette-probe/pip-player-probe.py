#!/usr/bin/env python3
"""Astra's media Picture-in-Picture window: floating, resizable, themed.

Opens the engine's real player window through `PictureInPicture.openPipWindow`
(the same entry point the PiP launcher uses) and checks the Astra face: the
stylesheet, the light/dark theme copied from the interface and followed live,
and the head strip. On Hyprland it also checks that the window is a floater
(`hyprctl clients`), which is the Linux proof that a tiling compositor no
longer gives it a tile; elsewhere that check is reported as SKIP.

  python3 tools/marionette-probe/pip-player-probe.py
Exit 0 PASS, 1 FAIL, 2 SKIP when the window cannot be opened.
"""
import json, os, shutil, signal, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = astra_env.BINARY
MPORT = 2954
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

profile = tempfile.mkdtemp(prefix='astra-pip-live-')
open(os.path.join(profile,'user.js'),'w').write(
    f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("media.videocontrols.picture-in-picture.enabled", true);\n'
)
log = open(os.path.join(profile,'browser.log'),'wb')
proc = subprocess.Popen([BIN,'-profile',profile,'-no-remote','-remote-allow-system-access','--marionette','about:blank'],
                        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
try:
    m=L.Marionette(MPORT, timeout=120)
    m.sock.settimeout(180)
    m.cmd('WebDriver:NewSession', {'capabilities': {}})
    m.cmd('WebDriver:SetTimeouts', {'script': 120000, 'implicit': 0, 'pageLoad': 60000})
    m.cmd('Marionette:SetContext', {'value':'chrome'})
    time.sleep(4)
    js = r'''
    const done=arguments[arguments.length-1];
    (async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const out={steps:[],diag:null};
      try {
      const step=(n,ok,d)=>out.steps.push({name:n,ok:ok===true,detail:d??null});
      for(let i=0;i<80;i++){if(Services.astraHost)break;await wait(250)}
      const frame=document.querySelector('.astra-frame');
      const before=frame?.getAttribute('data-astra-theme')||'dark';
      const {PictureInPicture}=ChromeUtils.importESModule("resource://gre/modules/PictureInPicture.sys.mjs");
      const win=await PictureInPicture.openPipWindow(window,{videoWidth:1280,videoHeight:720});
      window.__piptest=win;
      await wait(1200);
      const doc=win.document;
      const root=doc.documentElement;
      const head=doc.querySelector('.astra-pip-head');
      const min=doc.querySelector('.astra-pip-min');
      const css=doc.querySelector('link[href*="/pip/player.css"]');
      const bg=getComputedStyle(doc.body).backgroundColor;
      out.diag={theme:root.getAttribute('data-astra-theme'),astra:root.getAttribute('data-astra-pip'),
        head:head?.textContent, min:min?.getAttribute('aria-label'), css:css?.getAttribute('href'), bg,
        size:[win.outerWidth,win.outerHeight], uri:win.location.href};
      step('the player opens', !!win && win.location.href.includes('player.xhtml'));
      step('astra marks the player', root.getAttribute('data-astra-pip')==='');
      step('the player follows the interface theme', root.getAttribute('data-astra-theme')===before, before);
      step('the astra stylesheet loads', !!css);
      step('the astra ground is painted',
        bg===(root.getAttribute('data-astra-theme')==='light'?'rgb(241, 241, 243)':'rgb(26, 26, 29)'), bg);
      step('the head names the window', (head?.textContent||'').includes('Astra'));
      // The face follows the theme: a flat themed bar, not a white/black
      // gradient wash over the video, and text/glyphs that take the theme's
      // own text tone (dark on the light bar, light on the dark one).
      const lum=(s)=>{const m=String(s).match(/[\d.]+/g);if(!m)return null;
        const [r,g,b]=m.slice(0,3).map(Number);return 0.2126*r+0.7152*g+0.0722*b};
      const tone=(doc)=>{
        const g=(s)=>getComputedStyle(doc.querySelector(s));
        return {
          theme: root.getAttribute('data-astra-theme'),
          headImage: g('.astra-pip-head').backgroundImage,
          bottomImage: getComputedStyle(doc.getElementById('controls-bottom-gradient')).backgroundImage,
          headColor: g('.astra-pip-head').color,
          titleColor: g('.astra-pip-title').color,
          closeFill: getComputedStyle(doc.getElementById('close')).fill,
          closeBg: getComputedStyle(doc.getElementById('close')).backgroundColor,
          minColor: g('.astra-pip-min').color,
        };
      };
      const themed=(t)=>{
        const light=t.theme==='light';
        const head=lum(t.headColor), title=lum(t.titleColor), glyph=lum(t.closeFill);
        return {light, head, title, glyph,
          ok: t.headImage==='none' && t.bottomImage==='none' &&
              (light ? head<90 && title<110 && glyph<90
                     : head>180 && title>150 && glyph>180)};
      };
      const first=themed(tone(doc));
      out.diag.face=first;
      step('the head is a themed bar, not a gradient', tone(doc).headImage==='none');
      step('the controls plate is flat, not a gradient', tone(doc).bottomImage==='none');
      step('title and glyphs take the theme tone', first.ok, first);
      step('the close glyph is the theme text colour',
        getComputedStyle(doc.getElementById('close')).fill===getComputedStyle(head).color);
      frame?.setAttribute('data-astra-theme', before==='light'?'dark':'light');
      await wait(400);
      step('a theme change follows live', root.getAttribute('data-astra-theme')===(before==='light'?'dark':'light'));
      const flipped=themed(tone(doc));
      step('the face re-themes with the window', flipped.ok, flipped);
      frame?.setAttribute('data-astra-theme', before);
      step('the minimize control is present', !!min && /Minimize player/.test(min.getAttribute('aria-label')||''), min?.getAttribute('aria-label')??null);
      done(JSON.stringify(out));
      } catch (e) { out.error=String(e?.message??e)+" | "+String(e?.stack??''); done(JSON.stringify(out)); }
    })()
    '''
    out=json.loads(m.execute_async(js))
    print('out', json.dumps(out, indent=2))
    print('diag', json.dumps(out.get('diag'), indent=2))
    if out.get('error'):
        print(f"pip-player-probe: SKIP — {out['error']}", file=sys.stderr)
        sys.exit(2)
    hypr = None
    try:
        cl = json.loads(subprocess.check_output(['hyprctl', 'clients', '-j']).decode())
        pip = [w for w in cl if w.get('pid') == proc.pid and w.get('title') == 'Picture-in-Picture']
        hypr = bool(pip and pip[0].get('floating'))
        print('hypr pip', json.dumps([{k: w.get(k) for k in ('title', 'floating', 'size', 'at')} for w in pip], indent=2))
    except Exception:
        print('pip-player-probe: floating check SKIP (no hyprctl)', file=sys.stderr)
    close_js = "const done=arguments[arguments.length-1]; (async()=>{try{window.__piptest?.close(); done('closed')}catch(e){done('error '+e)}})()"
    m.execute_async(close_js)
    ok = bool(out.get('steps')) and all(s['ok'] for s in out['steps']) and hypr is not False
    print('PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
finally:
    try:
        os.killpg(proc.pid, signal.SIGTERM); proc.wait(timeout=15)
    except Exception:
        try: proc.kill()
        except Exception: pass
    log.close()
    import shutil; shutil.rmtree(profile, ignore_errors=True)
