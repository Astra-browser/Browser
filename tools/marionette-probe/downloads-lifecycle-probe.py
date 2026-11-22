"""Live probe: a real engine download can pause, resume, cancel and discard.

The Downloads UI renders Pause, Resume, Keep and Discard, so the host must
answer them from the engine instead of `unavailable`. This probe drives a real
slow transfer from a loopback server through the packaged dev build:

  1. a download starts and the host lists it as `receiving`
  2. `pause` stops the transfer and the wire state is `paused`
  3. `resume` starts the same entry again and it finishes at full size
  4. `keep` on a transfer the engine did not hold is refused honestly
  5. `cancel` stops a second transfer; `forget`/`discard` removes the entry

Usage: python3 tools/marionette-probe/downloads-lifecycle-probe.py [outdir]
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
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
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from marionette import Marionette  # noqa: E402

ROOT = astra_env.ROOT
FIREFOX = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_MARIONETTE_PORT", "2844"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/astra-downloads"
os.makedirs(OUT, exist_ok=True)

SIZE = 3 * 1024 * 1024
CHUNK = 64 * 1024
DELAY = 0.06  # ~3 s per transfer, long enough to pause mid-flight

if not os.path.exists(FIREFOX):
    print("SKIP no built binary at", FIREFOX)
    sys.exit(2)

class SlowFile(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        name = self.path.lstrip("/").split("?")[0] or "slow.bin"
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Content-Length", str(SIZE))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        remaining = SIZE
        try:
            while remaining > 0:
                body = b"a" * min(CHUNK, remaining)
                self.wfile.write(body)
                self.wfile.flush()
                remaining -= len(body)
                time.sleep(DELAY)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), SlowFile)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_port}"

def wait(read, timeout=30, step=0.2):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value

LIST = """
const host = Services.astraHost;
if (!host) return null;
return host.Downloads.call({profile:'default', call:{kind:'list', before:null, limit:50}})
  .then(r => JSON.stringify(r));
"""

def host_call(session, call):
    script = (
        "const host = Services.astraHost; if (!host) return null;"
        "return host.Downloads.call({profile:'default', call: arguments[0]})"
        ".then(r => JSON.stringify(r));"
    )
    raw = session.js(script, [call])
    return json.loads(raw) if raw else None

def list_entries(session):
    raw = session.js(LIST)
    if not raw:
        return None
    reply = json.loads(raw)
    if reply.get("kind") != "page":
        return []
    return reply.get("entries") or []

def find(session, filename, state=None):
    for entry in list_entries(session) or []:
        if entry.get("filename") == filename and (state is None or entry.get("state") == state):
            return entry
    return None

passed = 0
failed = 0

def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")

def trigger(session, name):
    reply = host_call(
        session,
        {"kind": "list", "before": None, "limit": 1},
    )
    if reply is None:
        raise RuntimeError("host Downloads missing")
    return session.js(
        "return Services.astraHost.Tabs.create({request_id:'dl-'+Date.now(),"
        " url: arguments[0], background:false}).then(r => JSON.stringify(r));",
        [f"{BASE}/{name}"],
    )

def main():
    base = os.environ.get("TMPDIR") or tempfile.gettempdir()
    os.makedirs(base, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-downloads-", dir=base)
    downloads = os.path.join(profile, "downloads")
    os.makedirs(downloads, exist_ok=True)
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as prefs:
        prefs.write(
            f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n'
            f'user_pref("browser.download.folderList", 2);\n'
            f'user_pref("browser.download.dir", {json.dumps(downloads)});\n'
            'user_pref("browser.download.useDownloadDir", true);\n'
            'user_pref("browser.download.always_ask_before_handling_new_types", false);\n'
            'user_pref("browser.download.manager.showWhenStarting", false);\n'
            'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/octet-stream");\n'
        )
    log = open(os.path.join(OUT, "browser.log"), "wb")
    process = subprocess.Popen(
        [
            FIREFOX,
            "-profile",
            profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    session = None
    try:
        session = Marionette(PORT)
        session.cmd("WebDriver:NewSession", {"capabilities": {}})
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        check(
            "app frame booted",
            wait(
                lambda: session.js(
                    "return document.querySelector('.astra-frame')"
                    "?.getAttribute('data-app-booted') === 'true';"
                ),
                60,
            )
            or False,
        )
        check(
            "host Downloads ready",
            wait(lambda: session.js("return !!(Services.astraHost && Services.astraHost.Downloads);"), 30)
            or False,
        )

        trigger(session, "slow.bin")
        entry = wait(lambda: find(session, "slow.bin", "receiving"), 40)
        check("download is listed as receiving", bool(entry), json.dumps(entry))
        if not entry:
            return
        first = entry
        wait(
            lambda: (
                (lambda e: e and int(e.get("received") or 0) > CHUNK)(find(session, "slow.bin"))
            ),
            15,
        )

        paused = host_call(session, {"kind": "pause", "id": first["id"]})
        check("pause is applied", paused and paused.get("kind") == "applied", json.dumps(paused))
        paused_entry = wait(lambda: find(session, "slow.bin", "paused"), 15)
        check("pause shows the paused state", bool(paused_entry), json.dumps(paused_entry))

        resumed = host_call(session, {"kind": "resume", "id": first["id"]})
        check("resume is applied", resumed and resumed.get("kind") == "applied", json.dumps(resumed))
        finished = wait(lambda: find(session, "slow.bin", "completed"), 90)
        check("resume finishes the transfer", bool(finished), json.dumps(finished))

        path = os.path.join(downloads, "slow.bin")
        check(
            "the finished file is on disk at full size",
            os.path.exists(path) and os.path.getsize(path) == SIZE,
            f"{path} exists={os.path.exists(path)}",
        )
        check(
            "the completed view names the file's target",
            finished
            and os.path.normcase(finished.get("target") or "") == os.path.normcase(path),
            json.dumps(finished),
        )
        check(
            "the completed view says the file exists",
            finished and finished.get("exists") is True and finished.get("deleted") is False,
            json.dumps(finished),
        )

        # The file is removed outside the browser. The next list must say so
        # instead of offering an Open that cannot work.
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
        missing = wait(
            lambda: (
                (lambda e: e and e.get("deleted") is True and e.get("exists") is False)(
                    find(session, "slow.bin")
                )
            ),
            15,
            step=0.4,
        )
        check("a deleted file is marked deleted in the viewer list", bool(missing), json.dumps(find(session, "slow.bin")))

        kept = host_call(session, {"kind": "keep", "id": first["id"]})
        check(
            "keep on a non-held transfer is refused honestly",
            kept and kept.get("kind") == "error" and kept.get("error") == "unavailable",
            json.dumps(kept),
        )
        kept_unknown = host_call(session, {"kind": "keep", "id": "00000000000000ff-0"})
        check(
            "keep of an unknown transfer is refused",
            kept_unknown
            and kept_unknown.get("kind") == "error"
            and kept_unknown.get("error") == "unavailable",
            json.dumps(kept_unknown),
        )

        # A second transfer: cancel while receiving, then discard the entry.
        trigger(session, "cancel.bin")
        second = wait(lambda: find(session, "cancel.bin", "receiving"), 40)
        check("second download is receiving", bool(second), json.dumps(second))
        if second:
            cancelled = host_call(session, {"kind": "cancel", "id": second["id"]})
            check("cancel is applied", cancelled and cancelled.get("kind") == "applied", json.dumps(cancelled))
            stopped = wait(lambda: find(session, "cancel.bin", "cancelled"), 20)
            check("cancel reaches a stopped state", bool(stopped), json.dumps(stopped))
            discarded = host_call(session, {"kind": "discard", "id": second["id"]})
            check("discard removes the stopped entry", discarded and discarded.get("kind") == "applied", json.dumps(discarded))
            gone = wait(lambda: find(session, "cancel.bin") is None, 10)
            check("the discarded entry is not listed", bool(gone))
    finally:
        try:
            if session:
                session.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            process.wait(timeout=15)
        except Exception:
            process.kill()
        server.shutdown()
        log.close()

    print(f"\ndownloads-lifecycle: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
