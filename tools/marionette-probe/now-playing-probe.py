#!/usr/bin/env python3
"""Now playing: the one card follows live media, and close sticks.

Serves a looping tone, opens a second tone in a new tab, switches to a silent
tab, and exercises the real Content projection: the card names the playing tab,
a silent switch does not clear it, a newer playback takes it, close stays
closed until that tab plays again, and the item projection marks the tab
audible for the rail.

Run on a machine with an audio device (or a compositor that reports an active
controller):
  python3 tools/marionette-probe/now-playing-probe.py
Exit 0 PASS, 2 SKIP when no controller activates.
"""
import http.server, io, json, math, os, signal, socketserver, struct, subprocess, sys, tempfile, threading, time, wave

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = astra_env.BINARY
PORT = 2943
MPORT = 2944
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

def tone(seconds=3, rate=8000):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(b"".join(struct.pack("<h", int(12000*math.sin(2*math.pi*440*i/rate))) for i in range(rate*seconds)))
    return out.getvalue()

TONE = tone()
PAGE = b"""<!doctype html><meta charset=utf-8><title>Tone Page</title>
<audio id=t src=/tone.wav autoplay loop></audio><p>tone</p>"""

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/tone.wav'):
            body, ctype = TONE, 'audio/wav'
        else:
            body, ctype = PAGE, 'text/html; charset=utf-8'
        self.send_response(200); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
class S(socketserver.TCPServer): allow_reuse_address = True
httpd = S(('127.0.0.1', PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile = tempfile.mkdtemp(prefix='astra-media-diag-')
open(os.path.join(profile,'user.js'),'w').write(
    f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("media.autoplay.default", 0);\n'
    'user_pref("media.autoplay.blocking_policy", 0);\n'
)
log = open(os.path.join(profile,'browser.log'),'wb')
proc = subprocess.Popen([BIN,'-profile',profile,'-no-remote','-remote-allow-system-access','--marionette','about:blank'],
                        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
try:
    m=L.Marionette(MPORT, timeout=120)
    m.sock.settimeout(180)
    m.cmd('WebDriver:NewSession', {'capabilities': {}})
    m.cmd('WebDriver:SetTimeouts', {'script': 150000, 'implicit': 0, 'pageLoad': 60000})
    m.cmd('Marionette:SetContext', {'value':'chrome'})
    time.sleep(4)
    js = r'''
    const done=arguments[arguments.length-1];
    (async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      let host=null;
      for(let i=0;i<80;i++){host=Services.astraHost;if(host?.Media&&host?.Tabs)break;await wait(250)}
      const out={steps:[],diag:null,itemAudio:0};
      const off=host.addEventListener(e=>{if(e.type==='items-changed'){out.itemAudio=(e.data?.tabs??[]).filter(t=>t.audio!=null).length}});
      off;
      const step=(name,ok,detail)=>out.steps.push({name,ok:ok===true,detail:detail??null});
      const tabs=async()=>((await host.Tabs.list({request_id:'mt'})).tabs??[]);
      const view=()=>host.Media.view();
      const waitView=async(pred,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=view();if(pred(v))return v;await wait(250)}return view()};
      const a=(await host.Tabs.create({request_id:'a',url:'http://127.0.0.1:%d/?a=1',background:false})).astra_tab_id;
      await wait(2500);
      {
        const ab=[...gBrowser.tabs].find(t=>t.getAttribute('astra-tab-id')===a)?.linkedBrowser;
        let active=false;
        try{active=ab?.browsingContext?.mediaController?.isActive===true}catch(e){active=false}
        if(!active){done(JSON.stringify({skip:'no active media controller in this display (no audio device)'}));return}
      }
      const b=(await host.Tabs.create({request_id:'b',url:'about:blank',background:true})).astra_tab_id;
      await wait(800);
      host.Media.player({id:a,action:{kind:'play'}});
      await waitView(v=>v?.tab_id===a);
      await host.Tabs.select({request_id:'sel-b',astra_tab_id:b});
      await wait(2500);
      out.diag={a,b,view:view(),tabs:(await tabs()).map(t=>({id:t.astra_tab_id,audio:t.audio,audible:t.audible,selected:t.selected,title:t.title}))};
      const app=()=>{try{return document.querySelector('iframe[data-astra-app-frame]')?.contentDocument}catch(e){return null}};
      const appDoc=app();
      step('a live card names the playing tab', view()?.tab_id===a, view());
      step('the sidebar player shows that title', appDoc?.querySelector('[data-media-title]')?.textContent==='Tone Page', appDoc?.querySelector('[data-media-title]')?.textContent??null);
      step('switching to a silent tab keeps it', view()?.tab_id===a, view());
      step('the playing tab is audible', (await tabs()).find(t=>t.astra_tab_id===a)?.audible===true);
      const c=(await host.Tabs.create({request_id:'c',url:'http://127.0.0.1:%d/?c=1',background:false})).astra_tab_id;
      await wait(3000);
      step('a newer playback takes the card', view()?.tab_id===c, view());
      const closed=await host.Media.player({id:c,action:{kind:'close'}});
      step('close is admitted', closed.accepted===true);
      await wait(2000);
      step('close sticks for that playback', view()?.tab_id!==c, view());
      step('another playing tab remains', view()?.tab_id===a, view());
      out.itemAudio=Math.max(out.itemAudio, (host.Tabs.__itemsSnapshot?.().tabs??[]).filter(t=>t.audio!=null).length);
      await host.Media.player({id:a,action:{kind:'pause'}});
      await wait(1500);
      step('paused playback keeps its card', view()?.tab_id===a, view());
      const closedA=await host.Media.player({id:a,action:{kind:'close'}});
      step('closing the last card is admitted', closedA.accepted===true);
      await wait(1000);
      step('no card is left', view()===null, view());
      step('the item projection lists playing tabs', out.itemAudio>=1);
      done(JSON.stringify(out));
    })()
    ''' % (PORT, PORT)
    out=json.loads(m.execute_async(js))
    if out.get('skip'):
        print(f"now-playing-probe: SKIP — {out['skip']}", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(out, indent=2))
    ok = bool(out.get('steps')) and all(s['ok'] for s in out['steps'])
    print('PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
finally:
    try:
        os.killpg(proc.pid, signal.SIGTERM); proc.wait(timeout=15)
    except Exception:
        try: proc.kill()
        except Exception: pass
    log.close(); httpd.shutdown()
    import shutil; shutil.rmtree(profile, ignore_errors=True)
