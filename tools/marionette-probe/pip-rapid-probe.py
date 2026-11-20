#!/usr/bin/env python3
"""Astra PiP: two requests in a row leave exactly one player.

The card's PiP control and the automatic tab-switch path both reach the
engine's launcher, and opening a window is asynchronous. Two requests inside
that latency used to turn into a toggle of the clone the first one had just
made (no player at all, while the tab kept saying Picture in Picture) or, when
both passed the "already cloning" check first, two player windows. The owner
report ("the video player says it is playing picture in picture and the popup
does not open, hit or miss") is that pair.

  python3 tools/marionette-probe/pip-rapid-probe.py
Exit 0 PASS, 2 SKIP when the clip never reaches an active media controller.
"""
import http.server, io, json, os, shutil, signal, socketserver, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = astra_env.BINARY
CLIP = os.path.join(ROOT, "engine/layout/reftests/webm-video/frames.webm")
PORT = 2968
MPORT = 2969
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

profile = tempfile.mkdtemp(prefix="astra-pip-rapid-")
clip = CLIP
try:
    generated = os.path.join(profile, "clip.webm")
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15:d=20",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
            "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "250k",
            "-c:a", "libopus", "-shortest", generated,
        ],
        check=True,
    )
    clip = generated
except Exception:
    pass


def read(path):
    with open(path, "rb") as handle:
        return handle.read()


PAGE = b"""<!doctype html><meta charset=utf-8><title>Astra PiP clip</title>
<style>html,body{margin:0;background:#111}video{width:100vw;height:100vh}</style>
<video id=v src=/clip.webm autoplay loop playsinline></video>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/clip.webm"):
            body, ctype = read(clip), "video/webm"
        else:
            body, ctype = PAGE, "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "none")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class S(socketserver.TCPServer):
    allow_reuse_address = True


httpd = S(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
open(os.path.join(profile, "user.js"), "w").write(
    f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("media.autoplay.default", 0);\n'
    'user_pref("media.autoplay.blocking_policy", 0);\n'
    'user_pref("media.volume_scale", "0.0");\n'
    'user_pref("media.videocontrols.picture-in-picture.enabled", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.video-toggle.always-show", true);\n'
)
log = open(os.path.join(profile, "browser.log"), "wb")
proc = subprocess.Popen(
    [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
    start_new_session=True,
)
try:
    m = L.Marionette(MPORT, timeout=120)
    m.sock.settimeout(180)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("WebDriver:SetTimeouts", {"script": 150000, "implicit": 0, "pageLoad": 60000})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(4)
    js = r"""
    const done=arguments[arguments.length-1];
    (async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      let host=null;
      for(let i=0;i<80;i++){host=Services.astraHost;if(host?.Media&&host?.Tabs)break;await wait(250)}
      const out={steps:[],cases:[]};
      const step=(name,ok,detail)=>out.steps.push({name,ok:ok===true,detail:detail??null});
      const pipWins=()=>[...Services.wm.getEnumerator('Toolkit:PictureInPicture')].filter(w=>!w.closed);
      const tabOf=(id)=>[...gBrowser.tabs].find(t=>t.getAttribute('astra-tab-id')===id);
      const closePip=async()=>{
        for(const w of pipWins()){try{w.close()}catch(e){}}
        const end=Date.now()+8000;
        while(Date.now()<end&&pipWins().length)await wait(150);
        await wait(600);
      };
      const a=(await host.Tabs.create({request_id:'rapid-page',url:'http://127.0.0.1:__PORT__/?clip=1',background:false})).astra_tab_id;
      await wait(3000);
      const native=tabOf(a);
      const browser=native?.linkedBrowser;
      let controller=null,active=false;
      try{controller=browser?.browsingContext?.mediaController??null}catch(e){}
      try{active=controller?.isActive===true}catch(e){}
      out.diag={tab:a,active};
      if(!active){done(JSON.stringify({skip:'no active media controller in this display'}));return}

      const open=()=>host.Media.player({id:a,action:{kind:'picture_in_picture'}});

      // One request is still an open.
      await closePip();
      const first=await open();
      await wait(3000);
      step('the control is admitted',first?.accepted===true,first);
      step('one request opens one player',pipWins().length===1,pipWins().length);
      step('the tab is marked picture in picture',native?.hasAttribute('pictureinpicture')===true);

      // Two requests inside the window-open latency.
      for(const gap of [0,40,120,300]){
        await closePip();
        const tabOpen=native?.hasAttribute('pictureinpicture')===true;
        step('the tab is clear before the '+gap+' ms pair',tabOpen!==true,tabOpen);
        const x=await open();
        await wait(gap);
        const y=await open();
        await wait(3500);
        const wins=pipWins().length;
        out.cases.push({gap,x:x?.accepted===true,y:y?.accepted===true,wins,
          tabPip:native?.hasAttribute('pictureinpicture')===true});
        step('a '+gap+' ms pair leaves exactly one player',wins===1,wins);
        step('the tab agrees with the '+gap+' ms pair',
          (wins===1)===(native?.hasAttribute('pictureinpicture')===true),
          {wins,tabPip:native?.hasAttribute('pictureinpicture')===true});
      }
      await closePip();
      step('the probe leaves no PiP window behind',pipWins().length===0,pipWins().length);
      done(JSON.stringify(out));
    })()
    """.replace("__PORT__", str(PORT))
    out = json.loads(m.execute_async(js))
    if out.get("skip"):
        print(f"pip-rapid-probe: SKIP — {out['skip']}", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(out, indent=2))
    ok = bool(out.get("steps")) and all(s["ok"] for s in out["steps"])
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
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
    httpd.shutdown()
    shutil.rmtree(profile, ignore_errors=True)
