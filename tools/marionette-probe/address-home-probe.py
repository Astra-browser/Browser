"""Live proof: the address bar lives in the column's head on every bar mode,
and a typed local address opens instead of being searched.

Run against the packaged Windows/Linux dev build after `build --faster`:

    python3 tools/marionette-probe/address-home-probe.py

The dev build is launched with its own throwaway profile; nothing touches the
person's real one.
"""

import json, os, socket, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2872
FIREFOX = astra_env.BINARY
TARGET = "localhost:3000"
EXPECTED = "http://localhost:3000/"


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


# The app frame is same-origin chrome; every check reads the real rendered
# field, not a mock.
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

STATE = "return (()=>{" + APP + """
  const side=d.querySelector('.browser-sidebar');
  const head=d.querySelector('.sidebar-top-field');
  const bar=d.querySelector('.stage-bar');
  return JSON.stringify({
    sidebarField: !!side && !!side.querySelector('[data-astra-address]'),
    head: !!head && !!head.querySelector('[data-astra-address]'),
    bar: !!bar,
    barField: !!bar && !!bar.querySelector('[data-astra-address]'),
    barHidden: bar ? bar.getAttribute('data-hidden') : null,
    count: d.querySelectorAll('[data-astra-address]').length
  });
})()"""


def main():
    profile = tempfile.mkdtemp(prefix="astra-address-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
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
        time.sleep(2)

        def state():
            return json.loads(m.js(STATE) or "{}")

        # 1. Full column: the field is in the column's head, the bar does not own it.
        s = state()
        print("default state", s)
        if not s.get("head"):
            failures.append("the column's head does not carry the address field")
        if not s.get("sidebarField"):
            failures.append("the sidebar does not carry the address field")
        if s.get("barField"):
            failures.append("the page bar still owns the address field")
        if s.get("count") != 1:
            failures.append(f"expected exactly one address field, found {s.get('count')}")

        # 2. Every page-bar mode: the field stays in the column, and the bar (where
        # the platform keeps one) never takes it.
        for mode in ("always", "auto", "hidden"):
            m.js("return Services.astraHost.Settings.set({request_id:'m',key:'ui.main-bar',value:arguments[0]});", [mode])
            time.sleep(0.8)
            s = state()
            print("mode", mode, s)
            if not s.get("sidebarField"):
                failures.append(f"mode {mode}: the sidebar lost the address field")
            if s.get("barField"):
                failures.append(f"mode {mode}: the page bar took the address field")

        # 3. A top-edge hover must not move the field either.
        m.js("(()=>{const f=document.querySelector('iframe[data-astra-app-frame]');"
             "f.contentWindow.postMessage({ns:'astra-shell',kind:'bar-hover',hover:true},'*');return 'ok';})()")
        time.sleep(0.8)
        s = state()
        print("hovered", s)
        if not s.get("sidebarField"):
            failures.append("a bar hover took the address field out of the column")

        # 4. A typed local address opens directly instead of being searched.
        m.js("return Services.astraHost.Settings.set({request_id:'m',key:'ui.main-bar',value:'auto'});")
        typed = m.js("return (()=>{" + APP + """
          const input=d.querySelector('[data-astra-address]');
          if(!input) return 'no field';
          input.focus();
          input.value=arguments[0];
          input.dispatchEvent(new f.contentWindow.InputEvent('input',{bubbles:true}));
          const form=input.form; if(!form) return 'no form';
          form.requestSubmit();
          return 'sent';
        })()""", [TARGET])
        print("typed", typed)
        if typed != "sent":
            failures.append(f"could not type into the address field ({typed})")

        opened = wait(lambda: m.js(
            "return Services.astraHost.Tabs.list({request_id:'p'}).then(r=>{const t=(r.tabs??[]).find(x=>x.selected)??(r.tabs??[])[0];return t?t.url:null;});"
        ) == EXPECTED, 20)
        active = m.js(
            "return Services.astraHost.Tabs.list({request_id:'q'}).then(r=>{const t=(r.tabs??[]).find(x=>x.selected)??(r.tabs??[])[0];return t?t.url:null;});"
        )
        print("opened", opened, "active", active)
        if not opened:
            failures.append(f"a typed local address did not open ({active})")
        if isinstance(active, str) and "google.com/search" in active:
            failures.append("a typed local address was searched instead of opened")
    finally:
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
    print("\nPASS: the address stays in the column for every bar mode; a typed local address opens.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
