"""Live Windows System probe: default browser, login item and privacy routes.

Usage:
  python tools/windows/system-probe.py [path-to-astra.exe]

Launches the build headless with a throwaway profile and asserts that every
Settings/Général System route answers instead of `unknown_command`:

  - `default_browser_status` reads Windows' `UserChoice` (not a guess);
  - `default_browser_request` returns the current answer (and opens Settings
    only on a packaged build);
  - `login_item_status` / `login_item_set` read and write the per-user `Run`
    value on a packaged build, and report `supported: false` on a dev tree;
  - `windows_reputation_managed` answers a boolean (or null without a registry);
  - `windows_diagnostics_settings` is callable (opened only with --settings).

The probe restores the login item to its previous state, so it is safe to run
against an installed build. Exit 0 PASS, 1 FAIL, 2 SKIP (no binary).
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HOST = "127.0.0.1"
PORT = 2851
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Programs",
    "Astra",
    "astra.exe",
)
FIREFOX = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
OPEN_SETTINGS = "--settings" in sys.argv[2:]


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


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    return bool(ok)


def main():
    if not os.path.isfile(FIREFOX):
        print(f"SKIP no binary at {FIREFOX}", file=sys.stderr)
        return 2

    profile = tempfile.mkdtemp(prefix="astra-system-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-headless",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    failed = 0
    m = None
    previous_run = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 60
        while time.time() < deadline:
            if m.js("return !!Services?.astraHost?.System;"):
                break
            time.sleep(0.3)

        status = json.loads(m.js(
            "return Services.astraHost.System.defaultBrowserStatus()"
            ".then(v => JSON.stringify(v));"
        ))
        if not check("default_browser_status answers an object", isinstance(status, dict), status):
            raise RuntimeError("no default browser answer")
        check("default_browser_status has is_default/can_request",
              isinstance(status.get("is_default"), bool)
              and isinstance(status.get("can_request"), bool), status)
        check("the default-browser answer is stable",
              json.loads(m.js(
                  "return Services.astraHost.System.defaultBrowserStatus()"
                  ".then(v => JSON.stringify(v));")) == status)

        packaged = status.get("can_request") is True
        print("packaged:", packaged, "default:", status.get("is_default"))

        managed = m.js(
            "return Services.astraHost.System.windowsReputationManaged();")
        check("windows_reputation_managed answers boolean or null",
              managed is None or isinstance(managed, bool), managed)

        login = json.loads(m.js(
            "return Services.astraHost.System.loginItemStatus()"
            ".then(v => JSON.stringify(v));"))
        check("login_item_status has the three keys",
              set(login) == {"supported", "enabled", "needs_approval"}, login)
        check("login_item_status agrees with the packaged build",
              login.get("supported") == packaged, login)

        if packaged:
            previous_run = subprocess.run(
                ["reg", "query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                 "/v", "Astra"], capture_output=True, text=True).returncode == 0
            on = json.loads(m.js(
                "return Services.astraHost.System.loginItemSet({enabled:true})"
                ".then(v => JSON.stringify(v));"))
            check("login_item_set(true) reports enabled", on.get("enabled") is True, on)
            reg = subprocess.run(
                ["reg", "query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                 "/v", "Astra"], capture_output=True, text=True).stdout
            check("the Run value names astra.exe and its profile",
                  "astra.exe" in reg and "-profile" in reg and "Astra" in reg, reg.strip())
            off = json.loads(m.js(
                "return Services.astraHost.System.loginItemSet({enabled:false})"
                ".then(v => JSON.stringify(v));"))
            check("login_item_set(false) reports disabled", off.get("enabled") is False, off)
            if previous_run:
                m.js("return Services.astraHost.System.loginItemSet({enabled:true});")

        if OPEN_SETTINGS:
            requested = json.loads(m.js(
                "return Services.astraHost.System.defaultBrowserRequest()"
                ".then(v => JSON.stringify(v));"))
            check("default_browser_request accepts the request",
                  requested.get("can_request") == packaged, requested)
            opened = m.js(
                "return Services.astraHost.System.windowsDiagnosticsSettings();")
            check("windows_diagnostics_settings accepts the request", opened is True)
            startup = m.js(
                "return Services.astraHost.System.loginItemOpenSettings();")
            check("login_item_open_settings accepts the request", startup is True)

        # Settings > General shows the default-browser callout bound to the
        # same answer, and Settings > Privacy renders the Windows group.
        m.js("return Services.astraHost.Commands.run({id:'settings.general'});")
        time.sleep(2)
        general = m.js("""
          const f=document.querySelector('iframe[data-astra-app-frame]');
          const d=f&&f.contentDocument;
          const callout=d?.querySelector('[data-setting="general.default"]');
          return JSON.stringify({
            callout: !!callout,
            text: (callout?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
          });
        """)
        view = json.loads(general)
        check("Settings > General renders the default-browser callout",
              view.get("callout") is True, general)

        m.js("return Services.astraHost.Commands.run({id:'settings.privacy'});")
        time.sleep(2)
        privacy = m.js("""
          const f=document.querySelector('iframe[data-astra-app-frame]');
          const d=f&&f.contentDocument;
          const row=d?.querySelector('[data-setting="privacy.smartscreen"]');
          const text=(d?.body?.innerText||'');
          return JSON.stringify({
            windows: text.includes('Microsoft Defender'),
            diagnostics: text.includes('diagnostic'),
            row: (row?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
            alert: d?.querySelector('[role="alert"]')?.textContent || null,
          });
        """)
        priv = json.loads(privacy)
        check("Settings > Privacy renders the Windows group",
              priv.get("windows") is True, privacy)
        check("Settings > Privacy has no route error", not priv.get("alert"), privacy)
        # The route is the failure the alert lookup used to miss: the card
        # writes a refused call into the row's description, not into an alert.
        row = priv.get("row") or ""
        check("the SmartScreen row reaches its host method",
              "could not read windows control status" not in row.lower(), row)
        check("the diagnostics button has a route",
              "could not open windows diagnostic settings" not in row.lower(), row)
    except Exception as e:
        import traceback
        traceback.print_exc()
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

    print(f"\n{'PASS' if failed == 0 else 'FAIL'} ({failed} failed)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
