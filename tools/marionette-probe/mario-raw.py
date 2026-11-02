"""Raw Marionette protocol client (stdlib only). Framing: LEN:JSON."""
import json
import socket
import sys

HOST, PORT = "127.0.0.1", 2828


class Marionette:
    def __init__(self):
        self.sock = socket.create_connection((HOST, PORT), timeout=30)
        self.f = self.sock.makefile("rb")
        self.buf = b""
        self._id = 0
        print("HANDSHAKE:", json.dumps(self._read())[:120])

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("server closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("server closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            # msg: [1, id, error, result]
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> ERROR {msg[2]}: {json.dumps(msg[3])[:800]}")
                return msg[3]
            # async event (e.g. [5, ...]) — ignore and keep reading
            print("ASYNC-IGNORED:", json.dumps(msg)[:200], file=sys.stderr)


def main():
    m = Marionette()
    print("SESSION:", json.dumps(m.cmd("WebDriver:NewSession", {"capabilities": {}}))[:300])
    print("CTX:", m.cmd("Marionette:GetContext"))
    print("SET-CHROME:", m.cmd("Marionette:SetContext", {"value": "chrome"}))
    info = m.cmd("WebDriver:ExecuteScript", {
        "script": """return JSON.stringify({
          appReady: (document.querySelector('[data-astra-app]')||{}).dataset?.appReady ?? null,
          appError: (document.querySelector('[data-astra-app] [role=alert]')||{}).textContent ?? null,
          slotError: (document.querySelector('[data-astra-content] [role=alert]')||{}).textContent ?? null,
          browsers: [...document.querySelectorAll('browser')].map(b => { try { return b.currentURI.spec } catch(e) { return 'ERR:'+e } }),
          title: document.title,
        })""",
        "args": [],
    })
    print("CHROME-DOM:", info)


if __name__ == "__main__":
    main()
