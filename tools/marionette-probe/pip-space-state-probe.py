#!/usr/bin/env python3
"""A PiP player from the older space stays live after a space is added.

Serves a clip whose title and MediaSession metadata move every two seconds,
plays it, adds a second space (which hides the source and opens automatic PiP),
and reads the real player chrome:

  - the source docshell is live and the clone keeps advancing,
  - the timestamp and scrubber move,
  - the head strip follows the site's title,
  - the transport follows a pause/play from Astra's card.

It then opens a player for a deliberately parked hidden source, the case where
the engine's marker has to wake the source itself.

  python3 tools/marionette-probe/pip-space-state-probe.py
Exit 0 PASS, 2 SKIP when no media controller activates.
"""
import http.server, json, os, shutil, signal, socketserver, subprocess, sys, tempfile, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2978
MPORT = 2979
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L


profile = tempfile.mkdtemp(prefix="astra-pip-space-")
clip = os.path.join(profile, "clip.webm")
subprocess.run(
    [
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15:d=120",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=120",
        "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "250k",
        "-c:a", "libopus", "-shortest", clip,
    ],
    check=True,
)
PAGE = b"""<!doctype html><meta charset=utf-8><title>Track 0</title>
<style>html,body{margin:0;background:#111}video{width:100vw;height:100vh}</style>
<video id=v src=/clip.webm autoplay loop playsinline></video>
<script>
let n = 0;
setInterval(() => {
  n++;
  document.title = "Track " + n;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Track " + n, artist: "Site Artist",
    });
  } catch (e) {}
}, 2000);
</script>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/clip.webm"):
            with open(clip, "rb") as handle:
                body = handle.read()
            ctype = "video/webm"
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
    f'user_pref("marionette.port", {MPORT});\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("media.autoplay.default", 0);\n'
    'user_pref("media.autoplay.blocking_policy", 0);\n'
    'user_pref("media.videocontrols.picture-in-picture.enabled", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.video-toggle.always-show", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true);\n'
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
    m.sock.settimeout(240)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("WebDriver:SetTimeouts", {"script": 200000, "implicit": 0, "pageLoad": 60000})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(4)
    js = r"""
    const done=arguments[arguments.length-1];
    (async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      let host=null;
      for(let i=0;i<80;i++){host=Services.astraHost;if(host?.Media&&host?.Tabs)break;await wait(250)}
      const out={steps:[],samples:[],skip:null};
      const step=(name,ok,detail)=>out.steps.push({name,ok:ok===true,detail:detail??null});
      const view=()=>host.Media.view();
      const waitView=async(pred,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=view();if(pred(v))return v;await wait(250)}return view()};
      const pipWins=()=>[...Services.wm.getEnumerator('Toolkit:PictureInPicture')].filter(w=>!w.closed);
      const waitPip=async(ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){const w=pipWins();if(w.length)return w[0];await wait(100)}return null};
      const closePip=async()=>{for(const w of pipWins()){try{w.close()}catch(e){}}const end=Date.now()+8000;while(Date.now()<end&&pipWins().length)await wait(150)};
      const player=(win)=>{try{const d=win?.document;return{
        playing:d?.getElementById('controls')?.classList?.contains('playing')??null,
        timestamp:d?.getElementById('timestamp')?.textContent??null,
        scrubber:d?.getElementById('scrubber')?.value??null,
        title:d?.querySelector('.astra-pip-title')?.textContent??null,
        playLabel:d?.getElementById('playpause')?.getAttribute('data-l10n-id')??null,
      }}catch(e){return{error:String(e)}}};
      const tabOf=(id)=>[...gBrowser.tabs].find(t=>t.getAttribute('astra-tab-id')===id);
      const a=(await host.Tabs.create({request_id:'page',url:'http://127.0.0.1:__PORT__/?a=1',background:false})).astra_tab_id;
      await wait(3000);
      const native=tabOf(a);
      const browser=native?.linkedBrowser;
      let controller=null;try{controller=browser?.browsingContext?.mediaController??null}catch(e){}
      for(let i=0;i<40;i++){let p=false;try{p=controller?.isPlaying===true}catch(e){};if(p)break;await wait(500)}
      if(controller?.isActive!==true){out.skip='no active media controller in this display (no audio device)';done(JSON.stringify(out));return}
      if(controller?.isPlaying!==true){await host.Media.player({id:a,action:{kind:'play'}});await wait(1000)}
      await waitView(v=>v?.tab_id===a);
      step('the page plays before the space',controller?.isPlaying===true);

      const made=await host.Tabs.createSpace({request_id:'new-space',name:'Second'});
      step('creating a space is admitted',made.accepted===true);
      const win=await waitPip(15000);
      step('automatic PiP opens the older space player',!!win,pipWins().length);
      await wait(1600);
      step('the source stays live for the clone',browser?.docShellIsActive===true,browser?.docShellIsActive);
      const first=player(win);
      await wait(2600);
      const second=player(win);
      out.samples.push({first,second});
      step('the player clock advances',first.timestamp!==null&&second.timestamp!==null&&first.timestamp!==second.timestamp,{first:first.timestamp,second:second.timestamp});
      step('the player scrubber advances',first.scrubber!==null&&second.scrubber!==null&&Number(second.scrubber)>Number(first.scrubber),{first:first.scrubber,second:second.scrubber});
      step('the player title follows the hidden site',first.title!==second.title,{first:first.title,second:second.title});
      step('the player shows playing',second.playing===true,second);
      await host.Media.player({id:a,action:{kind:'pause'}});
      await wait(1600);
      const paused=player(win);
      out.samples.push({paused});
      step('the player follows pause',paused.playing===false&&paused.playLabel!=='pictureinpicture-pause-btn',paused);
      await host.Media.player({id:a,action:{kind:'play'}});
      await wait(1600);
      const resumed=player(win);
      out.samples.push({resumed});
      step('the player follows play',resumed.playing===true,resumed);
      await closePip();

      // A player requested for a parked hidden source has to wake it itself.
      Services.prefs.setBoolPref('media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled',false);
      const state=host.Tabs.__itemsSnapshot?.();
      const older=state?.spaces?.find(s=>s.id!==state.active_space_id);
      if(older) await host.Tabs.switchSpace({request_id:'older',space:older.id});
      await wait(800);
      await host.Tabs.select({request_id:'back',astra_tab_id:a});
      await wait(1200);
      const b=(await host.Tabs.create({request_id:'silent',url:'about:blank',background:false})).astra_tab_id;
      await wait(1500);
      step('the source is parked while hidden',browser?.docShellIsActive===false,browser?.docShellIsActive);
      const opened=await host.Media.player({id:a,action:{kind:'picture_in_picture'}});
      step('the card PiP action is admitted',opened.accepted===true,opened);
      const parked=await waitPip(10000);
      step('the player opens for the parked source',!!parked,pipWins().length);
      await wait(900);
      step('the marker wakes the parked source',native?.hasAttribute('pictureinpicture')===true&&browser?.docShellIsActive===true,{attr:native?.hasAttribute('pictureinpicture'),active:browser?.docShellIsActive});
      await closePip();
      done(JSON.stringify(out));
    })()
    """.replace("__PORT__", str(PORT))
    out = json.loads(m.execute_async(js))
    if out.get("skip"):
        print(f"pip-space-state-probe: SKIP — {out['skip']}", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(out, indent=2))
    ok = bool(out["steps"]) and all(s["ok"] for s in out["steps"])
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
