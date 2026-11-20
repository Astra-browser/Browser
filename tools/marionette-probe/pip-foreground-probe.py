#!/usr/bin/env python3
"""Astra PiP foreground close: the player goes away when its tab comes back.

The player is a detour from the page, not a second home. Leaving the playing
tab keeps it open; selecting the tab it was cloned from closes it and the video
keeps playing inline. This covers both entry points:

  - a player opened from the Now playing card (the engine does not mark that
    one as auto-PiP, so the host performs the foreground close),
  - a player the engine opened by itself when the playing tab was left.

Returning before that automatic request finishes must not open a player over
the tab the person just came back to.

A redundant re-selection of the tab that is already in front (the model
re-asserts the selected tab while playback and the card update) must leave the
player alone.

Run on a machine with an audio device:
  python3 tools/marionette-probe/pip-foreground-probe.py
Exit 0 PASS, 2 SKIP when no media controller activates.
"""
import http.server, json, os, shutil, signal, socketserver, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = astra_env.BINARY
CLIP = os.path.join(ROOT, "engine/layout/reftests/webm-video/frames.webm")
PORT = 2967
MPORT = 2968
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

profile = tempfile.mkdtemp(prefix="astra-pip-foreground-")
clip = CLIP
try:
    generated = os.path.join(profile, "clip.webm")
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15:d=40",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=40",
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
    'user_pref("media.videocontrols.picture-in-picture.enabled", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.video-toggle.always-show", true);\n'
    'user_pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true);\n'
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
      const pipWins=()=>[...Services.wm.getEnumerator('Toolkit:PictureInPicture')].filter(w=>!w.closed);
      const waitPip=async(ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const wins=pipWins();if(wins.length)return wins[0];await wait(200)}return null};
      const waitGone=async(ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(!pipWins().length)return true;await wait(200)}return false};
      const tabOf=(id)=>[...gBrowser.tabs].find(t=>t.getAttribute('astra-tab-id')===id);
      const waitView=async(pred,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=view();if(pred(v))return v;await wait(250)}return view()};
      const {PictureInPicture}=ChromeUtils.importESModule("resource://gre/modules/PictureInPicture.sys.mjs");

      const a=(await host.Tabs.create({request_id:'fg-page',url:'http://127.0.0.1:__PORT__/?clip=1',background:false})).astra_tab_id;
      let native=null,browser=null,controller=null;
      {
        const end=Date.now()+30000;
        while(Date.now()<end){
          native=tabOf(a);browser=native?.linkedBrowser;
          try{controller=browser?.browsingContext?.mediaController??null}catch(e){controller=null}
          if(controller?.isActive===true&&controller?.isPlaying===true)break;
          await wait(250);
        }
      }
      let active=false,playing=false;
      try{active=controller?.isActive===true;playing=controller?.isPlaying===true}catch(e){}
      out.diag={tab:a,active,playing};
      if(!active){
        done(JSON.stringify({skip:'no active media controller in this display (no audio device)'}));
        return;
      }

      // Card-opened player: while the source tab is in front, the model
      // re-asserts the selection during playback. That must not close it.
      const opened=await host.Media.player({id:a,action:{kind:'picture_in_picture'}});
      const first=await waitPip();
      step('the card opens a player', opened.accepted===true&&!!first, opened);
      await host.Tabs.select({request_id:'fg-same',astra_tab_id:a});
      await wait(1200);
      step('re-selecting the tab already in front keeps the player', pipWins().length===1, pipWins().length);

      const silent=(await host.Tabs.create({request_id:'fg-silent',url:'about:blank',background:false})).astra_tab_id;
      await wait(2500);
      step('leaving the playing tab keeps the player', pipWins().length===1, pipWins().length);
      step('the source docshell stays active for the clone', browser?.docShellIsActive===true);

      await host.Tabs.select({request_id:'fg-back',astra_tab_id:a});
      step('selecting the playing tab closes the player', await waitGone(), pipWins().length);
      {
        const end=Date.now()+8000;
        while(Date.now()<end&&native?.hasAttribute('pictureinpicture')===true)await wait(200);
      }
      step('the tab leaves picture in picture', native?.hasAttribute('pictureinpicture')!==true);
      let keepsPlaying=false;
      {const end=Date.now()+8000;while(Date.now()<end){try{keepsPlaying=controller.isPlaying===true}catch(e){keepsPlaying=false}if(keepsPlaying)break;await wait(250)}}
      step('the video keeps playing in the page', keepsPlaying===true);
      const back=await waitView(v=>v?.tab_id===a&&v?.in_pip===false&&v?.playing===true,8000);
      step('the card follows the inline playback', back?.tab_id===a&&back?.in_pip===false, back);

      // Auto-PiP: leaving the tab lets the engine open its own player; coming
      // back closes it through the engine's foreground path.
      await host.Tabs.select({request_id:'fg-silent2',astra_tab_id:silent});
      const auto=await waitPip(20000);
      step('leaving again opens the automatic player', !!auto, pipWins().length);
      step('the engine recorded it as auto-PiP', browser?PictureInPicture.weakAutoPipBrowserToParent?.has(browser)===true:false);
      await host.Tabs.select({request_id:'fg-back2',astra_tab_id:a});
      step('selecting the playing tab closes the automatic player', await waitGone(), pipWins().length);
      step('no player is left behind', pipWins().length===0, pipWins().length);

      // Returning before the automatic request finishes must not leave a
      // player over the tab the person is already on.
      await host.Tabs.select({request_id:'fg-silent3',astra_tab_id:silent});
      await wait(50);
      await host.Tabs.select({request_id:'fg-race',astra_tab_id:a});
      await wait(4000);
      step('a request that loses the return race leaves no player', pipWins().length===0, pipWins().length);
      step('the tab is still in front after the race', gBrowser.selectedTab===native);

      for(const w of pipWins()){try{w.close()}catch(e){}}
      done(JSON.stringify(out));
    })()
    """.replace("__PORT__", str(PORT))
    out = json.loads(m.execute_async(js))
    if out.get("skip"):
        print(f"pip-foreground-probe: SKIP — {out['skip']}", file=sys.stderr)
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
