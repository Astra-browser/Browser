"""Navigate current tab to the packaged app; report title + root over time."""
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
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:600]}")
                return msg[3]


def main():
    m = Marionette()
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    print(m.cmd("WebDriver:Navigate", {"url": "resource://astra-app/browser-chrome.html"}))
    for i in range(12):
        time.sleep(10)
        try:
            title = m.cmd("WebDriver:GetTitle")
            root = m.cmd("WebDriver:ExecuteScript", {
                "script": "return JSON.stringify({title: document.title, rootLen: (document.getElementById('root')||{}).innerHTML?.length ?? -1, err: (document.querySelector('[role=alert]')||{}).textContent?.slice(0,120) ?? null})",
                "args": [],
            })
            print(f"t+{(i+1)*10}s title={title!r} root={root}")
        except Exception as e:
            print(f"t+{(i+1)*10}s ERROR {e}")
            break


if __name__ == "__main__":
    main()
