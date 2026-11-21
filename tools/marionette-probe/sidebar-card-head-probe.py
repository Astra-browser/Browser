"""Live proof: the card a put-away column slides out carries the page controls
and the one address field instead of leaving them in a bar hidden over the page.

Run against the packaged Windows/Linux dev build after `build --faster`:

    python3 tools/marionette-probe/sidebar-card-head-probe.py

The dev build is launched with its own throwaway profile; nothing touches the
person's real one.
"""

import functools, http.server, json, os, socket, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2875
WEB_PORT = 8897
FIREFOX = astra_env.BINARY

PAGE = b"""<!doctype html><meta charset=utf-8><title>Card head</title>
<body style="margin:0;background:#182028;color:#e6edf3;font:16px sans-serif">
<p style="padding:24px">The column is put away over this page.</p>"""


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=60)
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

    def js(self, s, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": args or []})["value"]


def wait(fn, timeout=30, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

STATE = "return (()=>{" + APP + """
  const side=d.querySelector('.browser-sidebar');
  const head=d.querySelector('.sidebar-top');
  const bar=d.querySelector('.stage-bar');
  return JSON.stringify({
    sideHidden: side ? side.getAttribute('data-hidden') : null,
    sidePeek: side ? side.getAttribute('data-peek') : null,
    headField: !!(head && head.querySelector('[data-astra-address]')),
    headNav: head ? head.querySelectorAll('.sidebar-top-row button').length : 0,
    barField: !!(bar && bar.querySelector('[data-astra-address]')),
    barHidden: bar ? bar.getAttribute('data-hidden') : null,
    count: d.querySelectorAll('[data-astra-address]').length
  });
})()"""

EDGE = ("const f=document.querySelector('iframe[data-astra-app-frame]');"
        "f.contentWindow.dispatchEvent(new f.contentWindow.CustomEvent("
        "'astra:sidebar-edge',{detail:{near:%s}}));return 'ok';")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass


def main():
    astra_env.require()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", WEB_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="astra-card-head-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
            'user_pref("astra.settings.sidebar.mode", "hidden");\n'
            'user_pref("astra.settings.ui.main-bar", "hidden");\n'
        )
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    failures = []
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        if not wait(lambda: m.js(
                "return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"), 60):
            failures.append("the app frame never booted")
        time.sleep(1)

        m.js("return Services.astraHost.Tabs.create({request_id:'t',url:arguments[0],selected:true});",
             [f"http://127.0.0.1:{WEB_PORT}/"])
        m.js("return Services.astraHost.Settings.set({request_id:'m',key:'ui.main-bar',value:'auto'});")

        def state():
            return json.loads(m.js(STATE) or "{}")

        # 1. Away over a live page: the bar is the field's only home.
        away = wait(lambda: (lambda s: s if s.get("sideHidden") == "true" else None)(state()), 20) or {}
        print("away", away)
        if not away.get("barField"):
            failures.append("the hidden bar does not carry the address field")
        if away.get("headField"):
            failures.append("the away column's head still carries the address field")

        # 2. The edge brings the card out: the head owns the controls and the field.
        m.js(EDGE % "true")
        peek = wait(lambda: (lambda s: s if s.get("sidePeek") == "true" else None)(state()), 20) or {}
        print("peek", peek)
        if not peek.get("headField"):
            failures.append("the card's head lost the address field")
        if peek.get("headNav", 0) < 4:
            failures.append("the card's head lost the page controls (Back/Forward/Reload/Home)")
        if peek.get("barField"):
            failures.append("the page bar kept a second address field while the card was out")
        if peek.get("count") != 1:
            failures.append(f"expected one address field while the card is out, found {peek.get('count')}")

        # 3. The card goes back: the field waits in the bar again.
        m.js(EDGE % "false")
        back = wait(lambda: (lambda s: s if s.get("sidePeek") is None and s.get("barField") else None)(state()), 20) or {}
        print("back", back)
        if not back.get("barField"):
            failures.append("the field did not return to the bar when the card went away")
        if back.get("headField"):
            failures.append("the away column's head kept the field after the card left")
        if back.get("count") != 1:
            failures.append(f"expected one address field after the card left, found {back.get('count')}")
    finally:
        server.shutdown()
        if m:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        time.sleep(1)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        log.close()

    if failures:
        print("\nFAIL")
        for failure in failures:
            print(" -", failure)
        return 1
    print("\nPASS: the put-away column's card keeps the page controls and the one address field.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
