# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""One Marionette client for the live probes.

The probes used to copy their own client, with three subtly different
constructors and method names (`js` vs `script`). This module is the single
implementation:

    from marionette import Marionette

    session = Marionette(port)                    # wait up to 90 s for the port
    session = Marionette(port, host="127.0.0.1", wait=0)
    session = Marionette(port, timeout=60, wait=0)

`cmd()` sends a protocol command, `js()` and `script()` are the same
`WebDriver:ExecuteScript` call under the two historical names.
"""
import json
import socket
import time


class Marionette:
    def __init__(self, port, host="127.0.0.1", timeout=30, wait=90):
        if wait:
            deadline = time.time() + wait
            while time.time() < deadline:
                try:
                    self.sock = socket.create_connection((host, port), timeout=timeout)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("no marionette")
        else:
            self.sock = socket.create_connection((host, port), timeout=timeout)
        self.file = self.sock.makefile("rb")
        self.seq = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.file.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.file.read(length - len(rest))
            if not chunk:
                raise EOFError("marionette closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self.seq += 1
        payload = json.dumps([0, self.seq, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            message = self._read()
            if isinstance(message, list) and len(message) == 4 and message[1] == self.seq:
                if message[2]:
                    raise RuntimeError(
                        f"{method} -> {message[2]}: {json.dumps(message[3])[:300]}"
                    )
                return message[3]

    def js(self, script, args=None):
        return self.cmd(
            "WebDriver:ExecuteScript", {"script": script, "args": args or []}
        )["value"]

    def script(self, script, args=None):
        return self.cmd(
            "WebDriver:ExecuteScript", {"script": script, "args": args or []}
        )["value"]
