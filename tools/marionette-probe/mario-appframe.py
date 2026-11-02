"""Read the APP frame document from chrome (no context switch needed)."""
import json
import socket


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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:1000]}")
                return msg[3]


APP_JS = """
const out = {browsers: [], appFrame: null};
for (const b of document.querySelectorAll('browser')) {
  let spec = null;
  try { spec = b.currentURI.spec; } catch (e) { spec = 'ERR:' + e; }
  out.browsers.push({spec, remote: b.getAttribute('remote'), type: b.getAttribute('type')});
  if (spec && spec.includes('browser-chrome.html')) {
    try {
      const doc = b.contentDocument;
      const root = doc && doc.getElementById('root');
      out.appFrame = {
        title: doc ? doc.title : 'NO-DOC',
        readyState: doc ? doc.readyState : '?',
        rootLen: root ? root.innerHTML.length : -1,
        rootHtml: root ? root.innerHTML.slice(0, 500) : null,
        scripts: doc ? [...doc.scripts].map(s => s.src || '(inline)') : [],
        bodyText: doc && doc.body ? doc.body.innerText.slice(0, 300) : null,
      };
    } catch (e) { out.appFrame = {error: String(e && e.message || e)}; }
  }
}
return JSON.stringify(out);
"""


def main():
    m = Marionette()
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    print(m.cmd("WebDriver:ExecuteScript", {"script": APP_JS, "args": []}))


if __name__ == "__main__":
    main()
