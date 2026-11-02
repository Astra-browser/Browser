"""Load diag framescript into the APP browser; print its reports + shell dataset."""
import json
import socket
import time


class Marionette:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", 2828), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        deadline = time.time() + 90
        while True:
            if time.time() > deadline:
                raise TimeoutError(method)
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:600]}")
                return msg[3]
            # async message: print anything interesting, keep waiting
            s = json.dumps(msg)[:500]
            if "diag" in s.lower() or "relay" in s.lower():
                print("ASYNC-MSG:", s, flush=True)


SETUP = """
const app = [...document.querySelectorAll('browser')].find(b => { try { return b.currentURI.spec.includes('browser-chrome.html') } catch(e) { return false } });
if (!app) return JSON.stringify({found: false});
const mm = app.messageManager;
mm.loadFrameScript('file:///tmp/diag-framescript.js', false);
mm.addMessageListener('diag-app-state', (msg) => { dump('DIAG-FRAMESTATE:' + JSON.stringify(msg.data) + '\\n'); });
const ds = document.querySelector('[data-astra-app]').dataset;
return JSON.stringify({found: true, relaySeen: ds.relaySeen ?? null, relayLast: ds.relayLast ?? null, appReady: ds.appReady ?? null, relayHelloError: ds.relayHelloError ?? null});
"""


def main():
    m = Marionette()
    print("SESSION", m.cmd("WebDriver:NewSession", {"capabilities": {}})["sessionId"][:8])
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    print("SETUP:", m.cmd("WebDriver:ExecuteScript", {"script": SETUP, "args": []}))
    print("listening 120s for diag reports...", flush=True)
    m.sock.settimeout(5)
    end = time.time() + 120
    while time.time() < end:
        try:
            msg = m._read()
            s = json.dumps(msg)
            if "diag" in s.lower() or "relay" in s.lower():
                print("ASYNC-MSG:", s[:800], flush=True)
        except (TimeoutError, socket.timeout):
            pass
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
