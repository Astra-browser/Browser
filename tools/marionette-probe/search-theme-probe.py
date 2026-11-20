"""Search latency + loading-skeleton theme probe.

Two regressions this guards:

  - Enter in the New Tab search (and the launcher) must resolve the typed words
    immediately, like the address field, instead of waiting for provider
    suggestions to settle.
  - The shell's page-load skeleton follows the app's light/dark choice; a light
    window must never show the dark skeleton.

Usage: python3 tools/marionette-probe/search-theme-probe.py [out-dir]
"""
import json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2872
FIREFOX = astra_env.BINARY
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/search-theme"


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(2 if self.path.startswith("/slow") else 0)
        body = b"<!doctype html><title>Probe</title><h1>Probe</h1>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
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
            raise RuntimeError("no marionette")
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

    def js(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def js_async(self, script, args=None):
        return self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})["value"]


def launch(profile, port):
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {port});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    return subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )


def connect(port):
    m = M(port)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    return m


def wait(fn, timeout=30, step=0.1):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def main():
    os.makedirs(OUT, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    profile = tempfile.mkdtemp(prefix="astra-search-")
    proc = launch(profile, PORT)
    failures = []
    m = None
    try:
        m = connect(PORT)
        wait(
            lambda: m.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"
            ),
            60,
        )
        time.sleep(2)
        theme = m.js(
            "return document.querySelector('.astra-frame')?.getAttribute('data-astra-theme');"
        )
        print("boot theme", theme, flush=True)
        if theme not in ("light", "dark"):
            failures.append("the shell did not receive the app's theme")

        # --- Enter in the New Tab search is immediate ----------------------
        dispatched = m.js(
            """return (()=>{
              const f=document.querySelector('iframe[data-astra-app-frame]');
              const d=f&&f.contentDocument;
              const i=d&&[...d.querySelectorAll('input')].find(
                (el)=>el.placeholder==='Search or enter an address');
              if(!i) return 'no field';
              i.focus();
              i.value='probe search';
              i.dispatchEvent(new d.defaultView.InputEvent('input',
                {bubbles:true, inputType:'insertText', data:'probe search'}));
              i.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',
                {key:'Enter', code:'Enter', bubbles:true}));
              return 'sent';
            })()"""
        )
        started = time.time()

        def current_url():
            return m.js_async(
                """const done = arguments[arguments.length - 1];
                (async () => {
                  try {
                    const r = await Services.astraHost.Tabs.list({ request_id: 's' });
                    const tab = (r.tabs || []).find((item) => item.astra_tab_id === r.selected_tab_id);
                    done((tab && tab.url) || '');
                  } catch (e) { done(''); }
                })()"""
            )

        opened = wait(
            lambda: (lambda url: url.startswith("https://") and ("probe%20search" in url or "probe+search" in url))(
                current_url()
            ),
            3.0,
            0.02,
        )
        elapsed = time.time() - started
        print("search dispatch", dispatched, "resolved in", round(elapsed, 3), "s", flush=True)
        if dispatched != "sent":
            failures.append("the New Tab search field was not found")
        if not opened:
            failures.append("Enter did not resolve the typed search")
        # The suggestion path is allowed 1.2 s; a queue behind it would miss
        # this budget. A host round trip is a few milliseconds.
        if elapsed > 0.8:
            failures.append(f"Enter waited for the provider answer ({elapsed:.2f}s)")

        # --- The loading skeleton follows the theme ------------------------
        def skeleton():
            return m.js(
                """return (()=>{const s=document.querySelector('.load-skeleton');
                  if(!s) return null;
                  const g=getComputedStyle(s).backgroundColor;
                  const k=document.querySelector('.sk');
                  const kk=k?getComputedStyle(k).backgroundImage:null;
                  return JSON.stringify({ground:g, sk:kk});})()"""
            )

        def load_slow():
            m.js(
                "return Services.astraHost.Navigation.loadURL({request_id:'slow',url:arguments[0]});",
                [base + "/slow"],
            )

        load_slow()
        light = wait(skeleton, 2.5)
        print("light skeleton", light, flush=True)
        if not light:
            failures.append("no loading skeleton on a slow page")
        else:
            values = json.loads(light)
            if "28, 27, 34" in values["ground"] or "#1c1b22" in values["ground"]:
                failures.append("the light window drew the dark skeleton ground")
            if values["sk"] and "58, 58, 68" in values["sk"]:
                failures.append("the light window drew the dark skeleton bars")

        m.js("return Services.astraHost.Commands.run({id:'theme.dark'});")
        wait(
            lambda: m.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-astra-theme')==='dark';"
            ),
            5,
        )
        print(
            "dark theme",
            m.js("return document.querySelector('.astra-frame')?.getAttribute('data-astra-theme');"),
            flush=True,
        )
        load_slow()
        dark = wait(skeleton, 2.5)
        print("dark skeleton", dark, flush=True)
        if not dark:
            failures.append("no loading skeleton after switching to dark")
        else:
            values = json.loads(dark)
            if "241, 241, 243" in values["ground"]:
                failures.append("the dark window kept the light skeleton ground")
        m.js("return Services.astraHost.Commands.run({id:'theme.light'});")

        print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures), flush=True)
        try:
            m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        if failures:
            sys.exit(1)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


main()
