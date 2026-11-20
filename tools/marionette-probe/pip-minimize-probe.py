#!/usr/bin/env python3
"""Astra PiP minimize: the player goes away and the media keeps playing.

Serves a short video with an audio track, opens the real PiP player through
the sidebar's `media_player` PiP action, presses Astra's minimize control in
the player, and checks:

  - the player window closes (it does not just hide off screen),
  - the originating tab leaves PiP,
  - the page's media controller is still playing,
  - pressing the sidebar PiP control opens the player again.

Run on a machine with an audio device or a compositor that reports an active
media controller:
  python3 tools/marionette-probe/pip-minimize-probe.py
Exit 0 PASS, 2 SKIP when no media controller activates.
"""
import http.server, io, json, os, shutil, signal, socketserver, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = astra_env.BINARY
CLIP = os.path.join(ROOT, "engine/layout/reftests/webm-video/frames.webm")
PORT = 2963
MPORT = 2964
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

profile = tempfile.mkdtemp(prefix="astra-pip-min-live-")
# Prefer a clip that carries a tone: the point of minimize is that the sound
# survives the window. The reftest clip is the fallback when ffmpeg is absent.
clip = CLIP
has_audio = False
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
    has_audio = True
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
    'user_pref("media.videocontrols.picture-in-picture.enabled", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.video-toggle.always-show", true);\n'
)
log = open(os.path.join(profile, "browser.log"), "wb")
proc = subprocess.Popen(
    [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
    cwd=os.path.dirname(BIN),
    stdout=log,
    stderr=subprocess.STDOUT,
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
      const out={steps:[],diag:null};
      const step=(name,ok,detail)=>out.steps.push({name,ok:ok===true,detail:detail??null});
      const view=()=>host.Media.view();
      const tabs=async()=>((await host.Tabs.list({request_id:'pip-min'})).tabs??[]);
      const waitView=async(pred,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=view();if(pred(v))return v;await wait(250)}return view()};
      const pipWins=()=>[...Services.wm.getEnumerator('Toolkit:PictureInPicture')].filter(w=>!w.closed);
      const waitPip=async(ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const wins=pipWins();if(wins.length)return wins[0];await wait(200)}return null};
      const tabOf=(id)=>[...gBrowser.tabs].find(t=>t.getAttribute('astra-tab-id')===id);
      const a=(await host.Tabs.create({request_id:'pip-min-page',url:'http://127.0.0.1:__PORT__/?clip=1',background:false})).astra_tab_id;
      await wait(3000);
      const native=tabOf(a);
      const browser=native?.linkedBrowser;
      let controller=null;
      try{controller=browser?.browsingContext?.mediaController??null}catch(e){controller=null}
      let active=false, playing=false;
      try{active=controller?.isActive===true;playing=controller?.isPlaying===true}catch(e){}
      out.diag={tab:a,active,playing,hasAudio:__HAS_AUDIO__};
      if(!active){
        done(JSON.stringify({skip:'no active media controller in this display (no audio device)'}));
        return;
      }
      const opened=await host.Media.player({id:a,action:{kind:'picture_in_picture'}});
      step('the PiP action is admitted', opened.accepted===true, opened);
      const first=await waitPip();
      step('the PiP player opens', !!first);
      await wait(1500);
      const v1=await waitView(v=>v?.tab_id===a&&v?.in_pip===true,8000);
      step('the card reports picture in picture', v1?.in_pip===true, v1);
      step('the tab is marked picture in picture', native?.hasAttribute('pictureinpicture')===true);
      const min=first?.document?.querySelector('.astra-pip-min');
      step('the minimize control is in the player', !!min, min?.getAttribute('aria-label')??null);

      // A tab switch and the model update that follows it are the live-site
      // case the owner reported. Parking the PiP source would make the page
      // fire VideoTabHidden again; auto-PiP treats that as a second toggle and
      // closes the player. The source must stay active and the window open.
      const silent=(await host.Tabs.create({request_id:'pip-silent',url:'about:blank',background:false})).astra_tab_id;
      await wait(2500);
      step('switching tabs keeps the player open', pipWins().length===1, pipWins().length);
      step('the source docshell stays active for the clone', native?.linkedBrowser?.docShellIsActive===true);
      const switched=await waitView(v=>v?.tab_id===a&&v?.in_pip===true,8000);
      step('the card follows the playing tab after the switch', switched?.tab_id===a, switched);
      step('the card still reports picture in picture', switched?.in_pip===true, switched);
      await host.Tabs.select({request_id:'pip-reselect',astra_tab_id:silent});
      await wait(2500);
      step('a model update does not close the player', pipWins().length===1, pipWins().length);
      step('a model update does not re-park the source', native?.linkedBrowser?.docShellIsActive===true);
      const churned=await waitView(v=>v?.tab_id===a&&v?.in_pip===true,8000);
      step('the card survives the model update', churned?.tab_id===a&&churned?.in_pip===true, churned);

      const raised=await host.Media.player({id:a,action:{kind:'picture_in_picture'}});
      await wait(500);
      step('the card raises the open player instead of opening another',
        raised.accepted===true && pipWins().length===1 && first?.closed===false,
        {accepted:raised.accepted,wins:pipWins().length,closed:first?.closed});

      min?.click();
      await wait(2500);
      step('the player window goes away', first?.closed===true, first?.closed);
      step('the tab leaves picture in picture', native?.hasAttribute('pictureinpicture')!==true);
      const v2=await waitView(v=>v?.tab_id===a&&v?.in_pip===false,8000);
      step('the card stays on the playing tab', v2?.tab_id===a&&v2?.in_pip===false, v2);
      let stillPlaying=false;
      try{stillPlaying=controller?.isPlaying===true}catch(e){stillPlaying=false}
      step('the media keeps playing in the background', stillPlaying===true);
      const {PictureInPicture}=ChromeUtils.importESModule("resource://gre/modules/PictureInPicture.sys.mjs");
      step('the engine suppresses auto-PiP after minimize', PictureInPicture.isAutoPipSuppressed(browser)===true);
      await host.Tabs.select({request_id:'pip-back',astra_tab_id:a});
      await wait(800);
      step('selecting the originating tab clears the suppression', PictureInPicture.isAutoPipSuppressed(browser)===false);
      const reopened=await host.Media.player({id:a,action:{kind:'picture_in_picture'}});
      step('the card opens the player again', reopened.accepted===true);
      const second=await waitPip();
      step('a second player window opens', !!second);
      second?.close();
      {
        const end=Date.now()+8000;
        while(Date.now()<end && pipWins().length) await wait(250);
      }
      step('the probe leaves no PiP window behind', pipWins().length===0, pipWins().length);
      done(JSON.stringify(out));
    })()
    """.replace("__PORT__", str(PORT)).replace("__HAS_AUDIO__", "true" if has_audio else "false")
    out = json.loads(m.execute_async(js))
    if out.get("skip"):
        print(f"pip-minimize-probe: SKIP — {out['skip']}", file=sys.stderr)
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
