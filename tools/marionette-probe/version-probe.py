"""Live probe: Astra's own product version in a running build.

Usage:
  python3 tools/marionette-probe/version-probe.py                 # dev build
  python3 tools/marionette-probe/version-probe.py <path-to-firefox>

Launches headless with a throwaway profile and asserts, against the build:

  - `astra.version` is the version in `branding/astra.toml` (the source of
    truth), not the Firefox pin
  - `about_info` answers `{version, os, arch}` with that version
  - Settings > About renders `Version <astra.version>`, with the platform line
  - the engine still reports the Firefox/Gecko version separately

Run this after bumping `version` and rebuilding, before handing the build out.
Exit 0 on PASS, 1 on FAIL.
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2837
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_BINARY = astra_env.BINARY
FIREFOX = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BINARY

with open(os.path.join(ROOT, "branding", "astra.toml"), encoding="utf-8") as f:
    match = re.search(r'^\s*version\s*=\s*"([^"]+)"', f.read(), re.MULTILINE)
EXPECTED = match.group(1) if match else None


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

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def main():
    if not EXPECTED:
        print("FAIL branding/astra.toml has no version", file=sys.stderr)
        return 1
    if not os.path.isfile(FIREFOX):
        print(f"SKIP no binary at {FIREFOX}", file=sys.stderr)
        return 2

    profile = tempfile.mkdtemp(prefix="astra-version-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [
            FIREFOX,
            "-profile",
            profile,
            "-no-remote",
            "-headless",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    failed = 0
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})

        def check(name, cond, detail=None):
            nonlocal failed
            print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" -- {detail}"))
            if not cond:
                failed += 1

        pref = m.js('return Services.prefs.getStringPref("astra.version", "");')
        check(f"astra.version pref is {EXPECTED}", pref == EXPECTED, pref)

        info = m.js("return Services.astraHost.System.aboutInfo()")
        check(f"about_info names version {EXPECTED}", (info or {}).get("version") == EXPECTED, info)
        check("about_info names a non-empty OS product", bool((info or {}).get("os")), info)
        check("about_info names a non-empty arch", bool((info or {}).get("arch")), info)

        engine = m.js("return Services.appinfo.version;")
        check("the engine still reports the Firefox pin", bool(engine) and engine != EXPECTED, engine)

        app = (
            "const f=document.querySelector('iframe[data-astra-app-frame]');"
            "const d=f&&f.contentDocument;"
        )
        booted = None
        deadline = time.time() + 90
        while time.time() < deadline:
            booted = m.js(
                "return document.querySelector('.astra-frame')"
                "?.getAttribute('data-app-booted');"
            )
            if booted == "true":
                break
            time.sleep(0.3)
        check("the app is booted", booted == "true", booted)

        m.js("return Services.astraHost.Commands.run({id:'settings.about'});")
        heading = version_text = platform_text = None
        deadline = time.time() + 30
        while time.time() < deadline:
            heading = m.js(
                "return (() => {" + app + "return d?.querySelector("
                "'.settings-page-heading h1')?.textContent.trim();})()"
            )
            version_text = m.js(
                "return (() => {" + app + "return d?.querySelector("
                "'.settings-about .version')?.textContent.trim();})()"
            )
            platform_text = m.js(
                "return (() => {" + app + "return d?.querySelector("
                "'.settings-about .platform')?.textContent.trim();})()"
            )
            if heading == "About" and version_text:
                break
            time.sleep(0.3)
        check("Settings opened on About", heading == "About", heading)
        check(f"About shows Version {EXPECTED}", version_text == f"Version {EXPECTED}", version_text)
        print(f"about: {version_text!r} · {platform_text!r}")
    finally:
        if m is not None:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    print(f"\n{'PASS' if failed == 0 else 'FAIL'} ({failed} failed)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
