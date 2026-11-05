"""Tabs settings probe: new-tab position, after-close, close buttons, archive,
native activation (automatic PiP prerequisite) and a real PiP attempt.

Usage: python3 tools/marionette-probe/tabs-settings-probe.py [out-dir]
"""
import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

HOST, PORT = "127.0.0.1", 2842
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/tabs-settings"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/video"):
            path = os.path.join(OUT, "clip.webm")
            body = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "video/webm")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/idle"):
            body = b"<!doctype html><title>idle</title><p>idle</p>"
        elif self.path.startswith("/a"):
            body = b"<!doctype html><title>A</title><p>A</p>"
        elif self.path.startswith("/b"):
            body = b"<!doctype html><title>B</title><p>B</p>"
        elif self.path.startswith("/c"):
            body = b"<!doctype html><title>C</title><p>C</p>"
        else:
            body = b"<!doctype html><title>fixture</title><p>fixture</p>"
        if self.path.startswith("/video"):
            pass
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class VideoPage(http.server.BaseHTTPRequestHandler):
    page = b"""<!doctype html><meta charset=utf-8><title>video</title>
<video id="v" src="/clip.webm" autoplay playsinline></video>
<script>
  const v = document.getElementById('v');
  const go = () => { v.muted = false; v.volume = 1; v.play().catch(() => {}); };
  const state = () => {
    document.title = (v.paused ? 'paused' : 'playing') + ':' +
      document.visibilityState + ':' + v.readyState + ':' +
      (v.mozHasAudio ? 'audio' : 'noaudio');
  };
  ['canplay','loadeddata','playing','pause','visibilitychange'].forEach(
    (name) => v.addEventListener(name, () => { if (name === 'canplay' || name === 'loadeddata') go(); state(); })
  );
  document.addEventListener('visibilitychange', state);
  document.addEventListener('mousemove', (e) => {
    document.title = 'mousemove:' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ':' + document.visibilityState;
  });
  setInterval(state, 400);
  go();
</script>"""

    def do_GET(self):
        if self.path.startswith("/clip.webm"):
            body = open(os.path.join(OUT, "clip.webm"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "video/webm")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.page)))
        self.end_headers()
        self.wfile.write(self.page)

    def log_message(self, *_args):
        pass


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("marionette did not open")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c:
                raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c:
                raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def shot(self, name):
        png = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(png))


def wait(fn, timeout=15, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:
            last = None
        time.sleep(step)
    return last


results = {"checks": [], "pass": False}


def check(name, ok, detail=None):
    results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- {detail}"), flush=True)


def host_get(m, key):
    return m.js("return Services.astraHost.Settings.get({key: " + json.dumps(key) + "});")


def host_set(m, key, value):
    return m.js(
        "return Services.astraHost.Settings.set({key: "
        + json.dumps(key)
        + ", value: "
        + json.dumps(value)
        + "});"
    )


def tabs(m):
    raw = m.js(
        "return Services.astraHost.Tabs.list({request_id:'probe'})"
        ".then((r) => JSON.stringify(r));"
    )
    return json.loads(raw or "{}")


def order(m):
    data = tabs(m)
    return [
        (t.get("astra_tab_id") or t.get("id"), t.get("url"), t.get("selected"))
        for t in data.get("tabs", [])
    ]


def selected(m):
    return tabs(m).get("selected_tab_id")


def create(m, url, background=True):
    raw = m.js(
        "return Services.astraHost.Tabs.create({request_id:'probe',url:"
        + json.dumps(url)
        + ",background:"
        + ("true" if background else "false")
        + "});"
    )
    return raw.get("astra_tab_id") if isinstance(raw, dict) else None


def select(m, tab_id):
    m.js(
        "return Services.astraHost.Tabs.select({request_id:'probe',astra_tab_id:"
        + json.dumps(tab_id)
        + "});"
    )
    time.sleep(0.4)


def close(m, tab_id):
    m.js(
        "return Services.astraHost.Tabs.close({request_id:'probe',astra_tab_id:"
        + json.dumps(tab_id)
        + "});"
    )
    time.sleep(0.4)


def main():
    os.makedirs(OUT, exist_ok=True)
    clip = os.path.join(OUT, "clip.webm")
    if not os.path.exists(clip):
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                "-t", "8", "-c:v", "libvpx-vp9", "-b:v", "300k",
                "-c:a", "libopus", "-b:a", "64k", clip,
            ],
            check=True,
        )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    video_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), VideoPage)
    threading.Thread(target=video_server.serve_forever, daemon=True).start()
    video_url = f"http://127.0.0.1:{video_server.server_address[1]}/video.html"

    profile = tempfile.mkdtemp(prefix="astra-tabs-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [
            FIREFOX,
            "-profile",
            profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 900})
        wait(
            lambda: m.js(
                js(
                    "return document.querySelector('.astra-frame')"
                    "?.getAttribute('data-app-booted') === 'true';"
                )
            ),
            90,
        )
        time.sleep(1)

        # Start from exactly three tabs A, B, C, with B selected.
        first = tabs(m).get("selected_tab_id")
        a = first
        b = create(m, base + "/b")
        c = create(m, base + "/c")
        select(m, b)
        rows = order(m)
        idx = {tid: i for i, (tid, _, _) in enumerate(rows)}
        check("three tabs exist", len(rows) >= 3, rows)
        check("B is selected", selected(m) == b, selected(m))

        # --- new tab position ---------------------------------------------
        host_set(m, "tabs.new-position", "after-current")
        new = create(m, base + "/new")
        rows = order(m)
        ids = [r[0] for r in rows]
        check(
            "after-current inserts the new tab after the selected tab",
            new in ids and ids.index(new) == ids.index(b) + 1,
            ids,
        )
        host_set(m, "tabs.new-position", "end")
        tail = create(m, base + "/tail")
        ids = [r[0] for r in order(m)]
        check("end inserts the new tab last", ids[-1] == tail, ids)

        # --- after closing a tab ------------------------------------------
        # Leave A, B, C only.
        for tid in [new, tail]:
            if tid:
                close(m, tid)
        rows = order(m)
        keep = [r[0] for r in rows][-3:]
        a, b, c = keep
        host_set(m, "tabs.after-close", "next")
        select(m, b)
        close(m, b)
        check("after-close next selects the next tab", selected(m) == c, selected(m))
        b = create(m, base + "/b2")
        # Put B back between A and C.
        m.js(
            "return Services.astraHost.Tabs.move({request_id:'probe',astra_tab_id:"
            + json.dumps(b)
            + ", index: 1});"
        )
        time.sleep(0.3)
        host_set(m, "tabs.after-close", "previous")
        select(m, b)
        close(m, b)
        check("after-close previous selects the previous tab", selected(m) == a, selected(m))
        b = create(m, base + "/b3")
        m.js(
            "return Services.astraHost.Tabs.move({request_id:'probe',astra_tab_id:"
            + json.dumps(b)
            + ", index: 1});"
        )
        time.sleep(0.3)
        host_set(m, "tabs.after-close", "recent")
        # B -> C -> B, then close B: recent must be C.
        select(m, b)
        select(m, c)
        select(m, b)
        close(m, b)
        check("after-close recent selects the previously active tab", selected(m) == c, selected(m))

        # --- close buttons -------------------------------------------------
        host_set(m, "tabs.close-button", "always")
        time.sleep(0.5)
        raw = m.js(
            js(
                "const close=d.querySelector('.tab-close');"
                "const list=close?.closest('[data-close-buttons]');"
                "return JSON.stringify({attr:list?list.getAttribute('data-close-buttons'):null,"
                "opacity:close?getComputedStyle(close).opacity:null});"
            )
        )
        info = json.loads(raw) if raw else {}
        check(
            "close buttons always is applied to the live rows",
            info.get("attr") == "always" and info.get("opacity") in ("1", "0.999999"),
            info,
        )
        host_set(m, "tabs.close-button", "hover")
        time.sleep(0.5)
        raw = m.js(
            js(
                "const close=d.querySelector('.tab-close');"
                "const list=close?.closest('[data-close-buttons]');"
                "return JSON.stringify({attr:list?list.getAttribute('data-close-buttons'):null,"
                "opacity:close?getComputedStyle(close).opacity:null});"
            )
        )
        info = json.loads(raw) if raw else {}
        check(
            "close buttons hover hides an unhovered close control",
            info.get("attr") == "hover" and info.get("opacity") in ("0", "0.0"),
            info,
        )

        # --- archive -------------------------------------------------------
        host_set(m, "tabs.archive", "12h")
        idle = create(m, base + "/idle", background=False)
        time.sleep(2.5)
        select(m, c)
        time.sleep(0.5)
        set_result = m.js(
            "return Services.astraHost.__setTabLastActiveForTests("
            + json.dumps(idle)
            + ", Date.now() - 13*3600*1000);"
        )
        swept = m.js(
            "return Services.astraHost.__archiveSweep({window_id:'win-1', now:Date.now()})"
            ".then((r)=>JSON.stringify(r));"
        )
        check(
            "archive 12h closes an idle Today tab",
            isinstance(swept, str) and idle in json.loads(swept).get("archived", []),
            swept,
        )
        still = tabs(m)
        check(
            "the archived tab is gone from the projection",
            all((t.get("astra_tab_id") or t.get("id")) != idle for t in still.get("tabs", [])),
        )
        history = m.js(
            "return PlacesUtils.history.fetch(" + json.dumps(base + "/idle") + ")"
            ".then((page)=>!!page).catch(()=>false);"
        )
        check("archive keeps the visit in History", history is True, history)
        host_set(m, "tabs.archive", "never")

        # --- activation / automatic PiP -----------------------------------
        m.js(
            "Services.prefs.setIntPref('media.autoplay.default',0);"
            "Services.prefs.setBoolPref("
            "'media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled',true);"
            "return true;"
        )
        host_set(m, "tabs.automatic-pip", "true")
        video = create(m, video_url, background=False)
        time.sleep(5)
        title = m.js(
            "const t=[...gBrowser.tabs].find(t=>t.linkedBrowser.currentURI.spec.startsWith("
            + json.dumps(video_url)
            + ")); return t?t.linkedBrowser.contentTitle:null;"
        )
        try:
            m.cmd("Marionette:SetContext", {"value": "content"})
            m.cmd("Marionette:SetContext", {"value": "chrome"})
        except Exception as error:
            print("VIDEO DEBUG ERR", error, flush=True)
            m.cmd("Marionette:SetContext", {"value": "chrome"})
        # Enter the video tab's <browser> as a frame so the synthetic hover
        # reaches its content document (the top-level content context is the
        # chrome window's about:blank).
        try:
            element = m.js(
                "const t=[...gBrowser.tabs].find(t=>t.linkedBrowser.currentURI.spec.startsWith("
                + json.dumps(video_url)
                + ")); return t?t.linkedBrowser:null;"
            )
            if isinstance(element, dict):
                m.cmd("WebDriver:SwitchToFrame", {"id": element, "focus": True})
                m.js(
                    "const v=document.querySelector('video');"
                    "if(v){const r=v.getBoundingClientRect();"
                    "for(let i=0;i<3;i++) v.dispatchEvent(new MouseEvent('mousemove',"
                    "{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));}"
                    "return true;"
                )
                time.sleep(0.6)
                m.cmd("WebDriver:SwitchToFrame", {"id": None})
        except Exception as error:
            try:
                m.cmd("WebDriver:SwitchToFrame", {"id": None})
            except Exception:
                pass

        # The PiP child only tracks a video after a real pointer move over it.
        try:
            m.cmd(
                "WebDriver:PerformActions",
                {
                    "actions": [
                        {
                            "type": "pointer",
                            "id": "mouse",
                            "parameters": {"pointerType": "mouse"},
                            "actions": [
                                {"type": "pointerMove", "duration": 200,
                                 "origin": "viewport", "x": 420, "y": 260},
                                {"type": "pause", "duration": 400},
                            ],
                        }
                    ]
                },
            )
        except Exception as error:
            print("HOVER DEBUG", error, flush=True)
        active = m.js(
            "return JSON.stringify([...gBrowser.tabs].map(t=>({"
            "url:t.linkedBrowser.currentURI.spec,"
            "active:t.linkedBrowser.docShellIsActive})));"
        )
        rows = json.loads(active or "[]")
        check(
            "the video tab is the active docshell",
            any(r["url"].startswith(video_url) and r["active"] for r in rows),
            rows,
        )
        select(m, c)
        time.sleep(0.5)
        rows = json.loads(
            m.js(
                "return JSON.stringify([...gBrowser.tabs].map(t=>({"
                "url:t.linkedBrowser.currentURI.spec,"
                "active:t.linkedBrowser.docShellIsActive})));"
            )
            or "[]"
        )
        video_row = next((r for r in rows if r["url"].startswith(video_url)), None)
        check(
            "switching away parks the video browser",
            video_row is not None and video_row["active"] is False,
            video_row,
        )
        pip = wait(
            lambda: m.js(
                "return Services.wm.getMostRecentWindow('Toolkit:PictureInPicture') !== null;"
            ),
            12,
        )
        check("automatic PiP opens the engine player on tab switch", pip is True, pip)
        if not pip:
            direct = m.js(
                "const t=[...gBrowser.tabs].find(t=>t.linkedBrowser.currentURI.spec.startsWith("
                + json.dumps(video_url)
                + ")); if(!t) return 'no-tab';"
                "const bc=t.linkedBrowser.browsingContext;"
                "if(!bc) return 'no-bc';"
                "const wg=bc.currentWindowGlobal; if(!wg) return 'no-wg';"
                "const a=wg.getActor('PictureInPictureLauncher');"
                "if(!a) return 'no-actor'; a.sendAsyncMessage('PictureInPicture:AutoToggle');"
                "return 'sent';"
            )
            direct_pip = wait(
                lambda: m.js(
                    "return Services.wm.getMostRecentWindow('Toolkit:PictureInPicture') !== null;"
                ),
                10,
            )
            if direct_pip:
                pip = True
                m.js(
                    "const w=Services.wm.getMostRecentWindow('Toolkit:PictureInPicture');"
                    "if(w) w.close(); return true;"
                )
        if pip:
            m.js(
                "const w=Services.wm.getMostRecentWindow('Toolkit:PictureInPicture');"
                "if(w) w.close(); return true;"
            )
        m.shot("tabs-final.png")
        results["pass"] = all(c["ok"] for c in results["checks"])
    finally:
        try:
            if m:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        time.sleep(0.8)
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass
        server.shutdown()
        video_server.shutdown()
        with open(os.path.join(OUT, "tabs-settings.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(json.dumps({"pass": results["pass"], "checks": len(results["checks"])}, indent=2))
    return 0 if results["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
