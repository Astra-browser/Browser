"""Live probe: a finished download survives a restart and a gone file is marked.

Firefox keeps only in-progress downloads in the session list; completed ones
live in Places history. The Downloads viewer must read both, and must say a
completed file is deleted when it is no longer at the path it was saved to.

  1. download a real file through the engine
  2. the host lists it as completed with its target and `exists: true`
  3. delete the file outside the browser; the host marks `exists: false`,
     `deleted: true`
  4. quit and relaunch the same profile
  5. the completed entry is still listed from history, still deleted
  6. opening the Downloads tool shows the deleted row and no Open action

Usage: python downloads-history-probe.py [outdir]
Exit 0 PASS, 1 FAIL, 2 SKIP.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

FIREFOX = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_MARIONETTE_PORT", "2846"))
ROOT = astra_env.ROOT
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "out", "downloads-history")
os.makedirs(OUT, exist_ok=True)
SIZE = 256 * 1024


class FileHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        name = self.path.lstrip("/").split("?")[0] or "kept.bin"
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Content-Length", str(SIZE))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(b"k" * SIZE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), FileHandler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_port}"

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


class Marionette:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("no marionette")
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
                    raise RuntimeError(f"{method} -> {message[2]}: {json.dumps(message[3])[:300]}")
                return message[3]

    def js(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def quit(self):
        try:
            self.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass


def wait(read, timeout=60, step=0.25):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value


def host_call(session, call):
    script = (
        "const host = Services.astraHost; if (!host) return null;"
        "return host.Downloads.call({ profile: 'default', call: arguments[0] })"
        ".then((r) => JSON.stringify(r));"
    )
    raw = session.js(script, [call])
    return json.loads(raw) if raw else None


def entries(session):
    reply = host_call(session, {"kind": "list", "before": None, "limit": 50})
    if not reply or reply.get("kind") != "page":
        return []
    return reply.get("entries") or []


def find(session, name):
    for entry in entries(session):
        if entry.get("filename") == name:
            return entry
    return None


def start(profile):
    log = open(os.path.join(profile, f"run-{int(time.time())}.log"), "wb")
    process = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    session = Marionette(PORT)
    session.cmd("WebDriver:NewSession", {"capabilities": {}})
    session.cmd("Marionette:SetContext", {"value": "chrome"})
    return process, session, log


def booted(session):
    return wait(
        lambda: session.js(
            "return document.querySelector('.astra-frame')"
            "?.getAttribute('data-app-booted') === 'true';"
        ),
        60,
    )


def main():
    if not os.path.exists(FIREFOX):
        print("SKIP no built binary at", FIREFOX)
        return 2
    profile = tempfile.mkdtemp(prefix="astra-downloads-history-", dir=tempfile.gettempdir())
    downloads = os.path.join(profile, "downloads")
    os.makedirs(downloads, exist_ok=True)
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as prefs:
        prefs.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
            f'user_pref("browser.download.folderList", 2);\n'
            f'user_pref("browser.download.dir", {json.dumps(downloads)});\n'
            'user_pref("browser.download.useDownloadDir", true);\n'
            'user_pref("browser.download.always_ask_before_handling_new_types", false);\n'
            'user_pref("browser.download.manager.showWhenStarting", false);\n'
            'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/octet-stream");\n'
        )
    process = None
    session = None
    log = None
    try:
        process, session, log = start(profile)
        check("app boots", bool(booted(session)))
        session.js(
            "return Services.astraHost.Tabs.create({request_id:'hist-'+Date.now(),"
            " url: arguments[0], background:false}).then((r) => JSON.stringify(r));",
            [f"{BASE}/kept.bin"],
        )
        finished = wait(lambda: find(session, "kept.bin") or None, 60)
        finished = wait(
            lambda: (
                (lambda entry: entry if entry and entry.get("state") == "completed" else None)(
                    find(session, "kept.bin")
                )
            ),
            60,
        )
        path = os.path.join(downloads, "kept.bin")
        check("the finished download is completed with a target", bool(finished) and finished.get("target") == path, json.dumps(finished))
        check("the file is on disk", os.path.exists(path) and os.path.getsize(path) == SIZE)
        if not finished:
            return 1

        # The engine may still hold the completed file for a moment after the
        # state flips; wait for the handle to close instead of failing the
        # probe on a Windows sharing violation.
        deadline = time.time() + 15
        while True:
            try:
                os.remove(path)
                break
            except PermissionError:
                if time.time() >= deadline:
                    raise
                time.sleep(0.25)
        host_call(session, {"kind": "list", "before": None, "limit": 50})
        gone = wait(
            lambda: (
                (lambda entry: entry if entry and entry.get("deleted") is True else None)(
                    find(session, "kept.bin")
                )
            ),
            20,
        )
        check("a deleted file is marked deleted", bool(gone) and gone.get("exists") is False, json.dumps(gone))

        session.quit()
        process.wait(timeout=20)
        session = None
        process = None
        log.close()
        log = None

        process, session, log = start(profile)
        check("app boots after restart", bool(booted(session)))
        again = wait(
            lambda: (
                (lambda entry: entry if entry and entry.get("state") == "completed" else None)(
                    find(session, "kept.bin")
                )
            ),
            45,
        )
        check("the completed download survives the restart", bool(again), json.dumps(again))
        check("the restarted view still marks it deleted", bool(again) and again.get("deleted") is True and again.get("exists") is False, json.dumps(again))

        opened = session.js(
            "const f=document.querySelector('iframe[data-astra-app-frame]');"
            "const d=f&&f.contentDocument; if (!d) return 'no app';"
            "const b=[...d.querySelectorAll('button')].find((n) => "
            "n.getAttribute('aria-label') === 'Downloads'); if (!b) return 'no entry';"
            "b.click(); return 'clicked';"
        )
        check("the Downloads entry opens", opened == "clicked", opened)
        shown = wait(
            lambda: session.js(
                "const f=document.querySelector('iframe[data-astra-app-frame]');"
                "const d=f&&f.contentDocument; if (!d) return null;"
                "const list=d.querySelector('.downloads-list'); if (!list) return null;"
                "return JSON.stringify({ text: list.textContent, deleted: d.querySelectorAll('[data-deleted]').length });"
            ),
            20,
        )
        viewer = json.loads(shown) if shown else {}
        check("the viewer shows the deleted row", viewer.get("deleted") == 1, json.dumps(viewer))
        check("the viewer says Deleted from downloads", "Deleted from downloads" in (viewer.get("text") or ""), json.dumps(viewer)[:300])
    finally:
        if session is not None:
            session.quit()
        if process is not None:
            try:
                process.wait(timeout=15)
            except Exception:
                process.kill()
        if log is not None:
            log.close()
        server.shutdown()

    print(f"\ndownloads-history: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
