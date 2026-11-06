"""Profiles switch probe: a switch hands the window over to the chosen profile.

Astra cannot move a running Firefox process to another profile directory, so
the switch launches the chosen profile and retires the window being left once
the new instance has opened. This probe asserts that contract: the switch is
accepted, the profile process starts, the old window closes, and the new
window is the chosen profile with a working tab model. It then removes the
probe profile.
"""
import json, os, socket, subprocess, sys, tempfile, time

HOST, PORT = "127.0.0.1", 2846
CLEANUP_PORT = 2847
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/profiles-switch"


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
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

    def js(self, s):
        return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": []})["value"]


def launch(profile, port):
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {port});\n')
    log = open(os.path.join(profile, "log"), "wb")
    return subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )


def connect(port, session=True):
    m = M(port)
    if session:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
    return m


def wait_closed(sock, timeout=12):
    end = time.time() + timeout
    while time.time() < end:
        try:
            sock.settimeout(0.5)
            if not sock.recv(1):
                return True
        except OSError:
            return True
        time.sleep(0.1)
    return False


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-switch-")
    proc = launch(profile, PORT)
    created = None
    try:
        m = connect(PORT)
        time.sleep(6)
        before = len(subprocess.run(["pgrep", "-f", FIREFOX], capture_output=True, text=True).stdout.split())
        made = m.js(
            "return Services.astraHost.Profiles.create({name:'Switch Probe',"
            "avatar:{style:'initials',color:1,symbol:0,photo:null}});"
        )
        print("create", made, flush=True)
        view = json.loads(m.js("return Services.astraHost.Profiles.get().then(r=>JSON.stringify(r));") or "{}")
        created = next((p["id"] for p in view.get("profiles", []) if p.get("name") == "Switch Probe"), None)
        print("profile", created, flush=True)
        # Let the new profile answer Marionette so its own window can be
        # inspected; this is probe-only configuration, not product state.
        with open(os.path.join(created, "user.js"), "w") as f:
            f.write(f'user_pref("marionette.port", {PORT});\n')
        switched = m.js("return Services.astraHost.Profiles.switch({profile:" + json.dumps(created) + "});")
        print("switch", switched, flush=True)
        assert switched.get("accepted") is True, "switch was not accepted"

        # The handoff: the old window goes, the new profile's process opens.
        old = m.sock
        m = None
        closed = wait_closed(old, 12)
        print("old window closed", closed, flush=True)
        assert closed, "the old window stayed open"

        new = None
        end = time.time() + 40
        while time.time() < end:
            try:
                new = connect(PORT)
                break
            except Exception:
                time.sleep(0.5)
        assert new is not None, "the switched-to profile did not open"
        after = len(subprocess.run(["pgrep", "-f", FIREFOX], capture_output=True, text=True).stdout.split())
        print("processes", before, after, flush=True)
        current = json.loads(new.js("return Services.astraHost.Profiles.get().then(r=>JSON.stringify(r));") or "{}")
        print("current profile", current.get("current"), flush=True)
        assert current.get("current") == created, "the new window is not the chosen profile"
        live = new.js("return Services.astraHost.Tabs.list({request_id:'still'}).then(r=>!!r.tabs);")
        print("new window has a tab model", live, flush=True)
        assert live is True
        try:
            new.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        time.sleep(1)

        # Remove the probe profile through the original profile's roster.
        cleaner = launch(profile, CLEANUP_PORT)
        try:
            cm = connect(CLEANUP_PORT)
            time.sleep(5)
            removed = cm.js(
                "return Services.astraHost.Profiles.remove({profile:" + json.dumps(created) + "});"
            )
            print("remove", removed, flush=True)
            try:
                cm.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        finally:
            time.sleep(0.5)
            try:
                cleaner.terminate()
                cleaner.wait(timeout=10)
            except Exception:
                pass
        print("VERDICT: PASS", flush=True)
    finally:
        subprocess.run(["pkill", "-f", created or "astra-switch-"], capture_output=True)
        time.sleep(0.5)
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


main()
