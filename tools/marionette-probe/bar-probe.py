import json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 2871
ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><title>Bar probe</title><h1>content</h1>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20); break
            except OSError: time.sleep(0.1)
        else: raise RuntimeError("no marionette")
        self.f = self.sock.makefile("rb"); self._id = 0; self._read()
    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c: raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0]); rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c: raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())
    def cmd(self, method, params=None):
        self._id += 1; p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]: raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]
    def js(self, s, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": args or []})["value"]


def wait(fn, timeout=30, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last: return last
        time.sleep(step)
    return last


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    profile = tempfile.mkdtemp(prefix="astra-bar-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen([FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
                            cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT)
    failures = []
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        wait(lambda: m.js("return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"), 60)
        time.sleep(3)
        # The hidden compositor freezes CSS transitions, so read final states.
        m.js("""(()=>{const st=document.createElement('style');st.textContent='*{transition:none!important;animation:none!important}';document.head.appendChild(st);return 'ok';})()""")

        app = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"
        home = m.js("return (()=>{" + app + """
          const bar=d.querySelector('.stage-bar');
          const content=document.querySelector('[data-astra-content]');
          const bodyFont=d.defaultView.getComputedStyle(d.body).fontFamily;
          return JSON.stringify({bar: !!bar, hidden: bar?.getAttribute('data-hidden')??null,
            top: content?Math.round(content.getBoundingClientRect().top):null,
            bodyFont, inter: d.fonts.check('13px InterVariable'),
            display: d.defaultView.getComputedStyle(d.documentElement).getPropertyValue('--font-display').trim()});
        })()""")
        print("home", home)
        h = json.loads(home)
        if not h["bar"]: failures.append("no page bar on the home page")
        if h["hidden"] == "true": failures.append("the home page hid the page bar")
        home_bar = m.js("return document.querySelector('.astra-frame')?.getAttribute('data-astra-bar');")
        print("home bar mode", home_bar)
        if home_bar != "flow": failures.append(f"the home page did not keep the bar in its row ({home_bar})")

        # Navigate the active tab to the local page.
        tabs = m.js("return Services.astraHost.Tabs.list({request_id:'b'}).then(r=>JSON.stringify(r));")
        first = json.loads(tabs)["tabs"][0]
        tab_id = first.get("id") or first.get("astra_tab_id")
        m.js("return Services.astraHost.Navigation.loadURL({request_id:'n',astra_tab_id:arguments[0],url:arguments[1]});", [tab_id, url])
        ok = wait(lambda: m.js("return document.documentElement.getAttribute('data-astra-stage') === 'page';"), 30)
        print("stage page", ok)
        time.sleep(1)
        floated = wait(lambda: m.js("return document.querySelector('.astra-frame')?.getAttribute('data-astra-bar') === 'overlay';"), 10)
        time.sleep(1.2)
        top = m.js("return Math.round(document.querySelector('[data-astra-content]').getBoundingClientRect().top);")
        collapsed = m.js("return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;return JSON.stringify({hidden:d?.querySelector('.stage-bar')?.getAttribute('data-hidden')??null, overlay:d?.querySelector('.stage-column')?.getAttribute('data-bar-overlay')??null, raised:d?.documentElement.getAttribute('data-astra-bar-raised'), open:document.querySelector('.astra-frame')?.getAttribute('data-astra-bar-open')});})()")
        print("page floating", floated, "content top", top, collapsed)
        if not floated: failures.append("the page bar left the row on a web page")
        if top > 12: failures.append(f"the page did not take the bar's row (top {top})")
        c = json.loads(collapsed)
        if c["hidden"] != "true": failures.append("the page bar did not hide on a web page")
        if c["overlay"] != "true": failures.append("the app did not mark the bar as floating")
        if c["raised"] != "true": failures.append("the app did not step its ground aside for the floating bar")
        if c["open"] != "true": failures.append("the shell was not raised for the floating bar")

        hover = m.js("return (()=>{" + app + """
          const r=d.querySelector('.bar-reveal'); if(!r) return 'no reveal';
          r.dispatchEvent(new d.defaultView.PointerEvent('pointerenter',{bubbles:true}));
          return 'sent';
        })()""")
        print("hover", hover)
        shown = wait(lambda: m.js("return document.querySelector('.astra-frame')?.getAttribute('data-astra-bar-shown') === 'true';"), 10)
        time.sleep(0.5)
        top2 = m.js("return Math.round(document.querySelector('[data-astra-content]').getBoundingClientRect().top);")
        bar_state = m.js("return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;const b=d?.querySelector('.stage-bar');return JSON.stringify({hidden:b?.getAttribute('data-hidden')??null, translate:b?getComputedStyle(b).transform:null});})()")
        print("shown on hover", shown, "content top", top2, bar_state)
        if not shown: failures.append("hovering the top edge did not reveal the bar")
        if top2 > 12: failures.append(f"revealing the bar moved the page (top {top2})")
        b = json.loads(bar_state)
        if b["hidden"] != "false": failures.append("the revealed bar still reports itself hidden")

        leave = m.js("return (()=>{" + app + """
          const b=d.querySelector('.stage-bar'); if(!b) return 'no bar';
          b.dispatchEvent(new d.defaultView.PointerEvent('pointerleave',{bubbles:true}));
          return 'sent';
        })()""")
        print("leave", leave)
        # The hide is deliberately delayed so the pointer can reach the bar.
        hidden2 = wait(lambda: m.js("return document.querySelector('.astra-frame')?.getAttribute('data-astra-bar-shown') === 'false';"), 10)
        print("hidden again", hidden2)
        if not hidden2: failures.append("the bar did not hide after the pointer left")

        # The engine's page menu is refused and the app's own menu answers.
        m.js("""(()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;d.defaultView.addEventListener('message',e=>{if(e.data&&e.data.ns==='astra-shell'){(d.defaultView.__astraMsgs=d.defaultView.__astraMsgs||[]).push(e.data.kind);if(e.data.kind==='menu')d.defaultView.__astraMenu=e.data;}});return 'listening';})()""")
        opened = m.js("""return (()=>{
          const b = gBrowser.selectedBrowser;
          window.gContextMenu = {
            shouldDisplay: true, browser: b,
            contentData: { context: { screenXDevPx: 180, screenYDevPx: 160 } },
            onLink: true, linkURL: 'https://example.com/probe', linkTextStr: 'Example',
            onVideo: false, onAudio: false, onImage: false,
            isContentSelected: false, selectedText: '', mediaURL: ''
          };
          const popup = document.getElementById('contentAreaContextMenu');
          const ev = new Event('popupshowing', { bubbles: false, cancelable: true });
          const allowed = popup.dispatchEvent(ev);
          const f = document.querySelector('iframe[data-astra-app-frame]');
          return JSON.stringify({ prevented: !allowed, cw: !!f?.contentWindow, link: window.gContextMenu?.linkURL ?? null, should: window.gContextMenu?.shouldDisplay ?? null,
            tab: !!gBrowser.getTabForBrowser(b), target: window.__astraMenuTarget ?? null,
            shellMenu: !!document.querySelector('.astra-shell-menu'), appMenu: !!f?.contentDocument?.querySelector('.shell-menu') });
        })()""")
        print("native page menu", opened)
        if json.loads(opened).get("prevented") is not True:
            failures.append("the engine page menu was not prevented")
        menu = wait(lambda: m.js("""return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;const m=d&&d.querySelector('.shell-menu');return m?JSON.stringify([...m.querySelectorAll('[role=menuitem]')].map(x=>x.textContent.trim())):null;})()"""), 10)
        diag = m.js("""return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;return JSON.stringify({msgs:d.defaultView.__astraMsgs||null,gotMenu:!!d.defaultView.__astraMenu,frameReady:f?.getAttribute('data-app-ready')||null,menus:d.querySelectorAll('[role=menu]').length,shellMenu:!!document.querySelector('.astra-shell-menu'),target:window.__astraMenuTarget??null});})()""")
        print("app page menu", menu, diag)
        labels = json.loads(menu) if menu else []
        if "Copy Link Address" not in labels:
            failures.append("the page menu did not reach the app")
        clicked = m.js("""return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;const row=[...d.querySelectorAll('.shell-menu [role=menuitem]')].find(x=>x.textContent.includes('Select All'));if(!row)return 'no row';row.click();return 'clicked';})()""")
        print("menu row", clicked)
        time.sleep(1)
        gone = m.js("""return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;return !d.querySelector('.shell-menu');})()""")
        if clicked != "clicked" or not gone:
            failures.append("the page menu row did not run and close")

        print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
        return 0 if not failures else 1
    finally:
        try: m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception: pass
        time.sleep(0.5)
        try: proc.terminate(); proc.wait(timeout=10)
        except Exception: pass
        server.shutdown()


sys.exit(main())
