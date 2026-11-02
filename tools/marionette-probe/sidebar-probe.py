"""Sidebar peek probe: hide the column, watch it settle, then drive the edge.

Usage: python3 tools/marionette-probe/sidebar-probe.py <profile-dir> <out-dir>
"""
import json
import os
import socket
import subprocess
import sys
import time

HOST, PORT = "127.0.0.1", 2828
FIREFOX = "engine/obj-astra-linux/dist/bin/firefox"
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


HIDE = js("""
  if (!d) return 'no doc';
  const b = [...d.querySelectorAll('header button')].find((x) => /toggle sidebar/i.test(x.getAttribute('aria-label') || ''));
  if (!b) return 'no button';
  b.click();
  return 'ok';
""")

STATE = js("""
  if (!d) return null;
  const a = d.querySelector('aside.browser-sidebar');
  return JSON.stringify({
    hidden: !!(a && a.hasAttribute('data-hidden')),
    peek: !!(a && a.hasAttribute('data-peek')),
    edge: !!d.querySelector('.sidebar-edge'),
  });
""")

EDGE = lambda near: js(f"""
  if (!d) return 'no doc';
  const e = d.querySelector('.sidebar-edge');
  if (!e) return 'no strip';
  e.dispatchEvent(new PointerEvent('pointer{' + ("enter" if near else "leave") + '}', {{ bubbles: false }}));
  return 'ok';
""")


class M:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError
            data += chunk
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            rest += self.f.read(n - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            m = self._read()
            if isinstance(m, list) and len(m) == 4 and m[1] == self._id:
                if m[2]:
                    raise RuntimeError(m)
                return m[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
        stdout=log, stderr=subprocess.STDOUT)
    m = None
    for _ in range(60):
        try:
            m = M(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("no marionette")
        proc.terminate()
        return 1
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(20)

    print("hide:", m.js(HIDE))
    for i in range(8):
        time.sleep(1)
        print(f"t+{i + 1}s:", m.js(STATE))

    print("edge event:", m.js(js("""
      const w = d.defaultView;
      w.dispatchEvent(new w.CustomEvent('astra:sidebar-edge', { detail: { near: true } }));
      return 'ok';
    """)))
    time.sleep(1.5)
    print("after event:", m.js(STATE))
    print("edge in:", m.js(EDGE(True)))
    time.sleep(1.5)
    print("after in:", m.js(STATE))
    print("edge out:", m.js(EDGE(False)))
    for i in range(4):
        time.sleep(1)
        print(f"out+{i + 1}s:", m.js(STATE))
    proc.terminate()
    return 0


sys.exit(main())
