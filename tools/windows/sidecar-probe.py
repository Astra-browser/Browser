"""Live Windows probe: the shell finds and starts astra-core.exe.

Usage:
  python tools/windows/sidecar-probe.py engine/obj-astra-windows/dist/bin/firefox.exe

Launches the build headless with Marionette and a throwaway profile. Passes only
when the shell's `data-core` is `running`, the installed binary exists beside the
browser, the sidecar process is alive, and the profile's core.sqlite exists.
Exit 0 on PASS, 1 on FAIL, 2 when the binary is absent.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HOST = "127.0.0.1"
PORT = 2841
FIREFOX = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "engine", "obj-astra-windows", "dist", "bin", "firefox.exe",
)


class M:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("marionette did not open")
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


def main():
    if not os.path.isfile(FIREFOX):
        print(f"SKIP no binary at {FIREFOX}", file=sys.stderr)
        return 2
    profile = tempfile.mkdtemp(prefix="astra-sidecar-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-headless",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    m = None
    failed = 0
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        state = {}
        deadline = time.time() + 20
        while time.time() < deadline:
            state = json.loads(m.cmd("WebDriver:ExecuteScript", {
                "script": """
const f = document.querySelector('.astra-frame');
return JSON.stringify({
  core: f?.dataset.core ?? null,
  command: f?.dataset.coreCommand ?? null,
  db: f?.dataset.coreDb ?? null,
  exists: !!f?.dataset.coreCommand && (() => {
    try { const x = Services.dirsvc.get("GreD", Ci.nsIFile).clone(); x.append("astra-core.exe"); return x.exists(); }
    catch { return false; }
  })(),
});
""",
                "args": [],
            })["value"])
            if state.get("core") == "running":
                break
            time.sleep(0.5)

        def check(name, cond, detail=None):
            nonlocal failed
            print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" -- {detail}"))
            if not cond:
                failed += 1

        check("shell found astra-core.exe", bool(state.get("command")) and state.get("exists") is True, state)
        check("shell reports core running", state.get("core") == "running", state)
        time.sleep(2)
        tasks = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq astra-core.exe"],
            capture_output=True, text=True,
        ).stdout
        check("astra-core.exe process is alive", "astra-core.exe" in tasks, tasks)
        db = state.get("db") or ""
        check("profile core.sqlite exists", bool(db) and os.path.isfile(db), db)
    except Exception as e:
        print(f"FAIL probe error: {e}", file=sys.stderr)
        failed += 1
    finally:
        if m is not None:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        try:
            proc.wait(timeout=20)
        except Exception:
            proc.kill()
        log.close()
        time.sleep(1)
        tasks = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq astra-core.exe"],
            capture_output=True, text=True,
        ).stdout
        if "astra-core.exe" in tasks:
            print("FAIL astra-core.exe outlived the browser")
            failed += 1
        else:
            print("PASS astra-core.exe stopped with the browser")
        subprocess.run(["taskkill", "/IM", "astra-core.exe", "/F"], capture_output=True)
    print(f"{'PASS' if failed == 0 else 'FAIL'} ({failed} failed)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
