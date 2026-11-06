"""Window-corner probe: the borderless Astra window is rounded on Linux.

A non-zero radius on the document root also makes Gecko create a transparent
widget, so the desktop shows through the corners. The rule must stay in force
for a normal or tiled/maximized window and stand down for a fullscreen one.

Usage: python3 tools/marionette-probe/window-radius-probe.py
"""
import json, os, socket, subprocess, tempfile, time

HOST, PORT = "127.0.0.1", 2875
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")


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


def launch(profile, port):
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {port});\n')
    log = open(os.path.join(profile, "log"), "wb")
    return subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )


def shape(m):
    return json.loads(
        m.js(
            """return JSON.stringify((()=>{const d=document.documentElement;const s=getComputedStyle(d);
              return {state:d.getAttribute('sizemode'), radius:s.borderRadius, overflow:s.overflow,
                background:s.backgroundColor, domFullscreen:d.hasAttribute('inDOMFullscreen')};})())"""
        )
    )


def set_state(m, state, dom_fullscreen=False):
    return m.js(
        """return (()=>{const d=document.documentElement;
          if(arguments[0]===null)d.removeAttribute('sizemode');else d.setAttribute('sizemode',arguments[0]);
          if(arguments[1])d.setAttribute('inDOMFullscreen','true');else d.removeAttribute('inDOMFullscreen');
          return 'ok';})()""",
        [state, dom_fullscreen],
    )


def check(name, ok, failures):
    print(("PASS " if ok else "FAIL ") + name, flush=True)
    if not ok:
        failures.append(name)


def main():
    profile = tempfile.mkdtemp(prefix="astra-radius-")
    proc = launch(profile, PORT)
    failures = []
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        for _ in range(120):
            if m.js("return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"):
                break
            time.sleep(0.5)
        time.sleep(1)
        original = shape(m)
        print("initial", original, flush=True)

        set_state(m, "normal")
        time.sleep(0.2)
        normal = shape(m)
        check("normal window has the 14px radius", normal["radius"] == "14px", failures)
        check("normal window clips its content", normal["overflow"] == "hidden", failures)
        check("normal window is transparent behind the corners", normal["background"] == "rgba(0, 0, 0, 0)", failures)

        set_state(m, "maximized")
        time.sleep(0.2)
        tiled = shape(m)
        check("a tiled/maximized window keeps the radius", tiled["radius"] == "14px", failures)

        set_state(m, "fullscreen")
        time.sleep(0.2)
        full = shape(m)
        check("a fullscreen window is square", full["radius"] == "0px", failures)

        set_state(m, "normal", True)
        time.sleep(0.2)
        dom = shape(m)
        check("DOM fullscreen is square", dom["radius"] == "0px", failures)

        set_state(m, original["state"])
        print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures), flush=True)
        try:
            m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        if failures:
            raise SystemExit(1)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


main()
