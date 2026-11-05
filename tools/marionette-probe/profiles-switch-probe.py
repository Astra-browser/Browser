"""Profiles switch probe: the chosen profile opens without quitting this one."""
import json, os, socket, subprocess, sys, tempfile, time

HOST, PORT = "127.0.0.1", 2846
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/profiles-switch"

class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20); break
            except OSError: time.sleep(0.1)
        else: raise RuntimeError("no marionette")
        self.f = self.sock.makefile("rb"); self._id = 0; self._read()
    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c: raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0]); rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c: raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())
    def cmd(self, method, params=None):
        self._id += 1; p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]: raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]
    def js(self, s): return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": []})["value"]

def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-switch-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen([FIREFOX, "-profile", profile, "-no-remote",
                             "-remote-allow-system-access", "--marionette", "about:blank"],
                            cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT)
    m = None
    created = None
    try:
        m = M(PORT); m.cmd("WebDriver:NewSession", {"capabilities": {}}); m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(6)
        before = len(subprocess.run(["pgrep", "-f", FIREFOX], capture_output=True, text=True).stdout.split())
        made = m.js(
            "return Services.astraHost.Profiles.create({name:'Switch Probe',"
            "avatar:{style:'initials',color:1,symbol:0,photo:null}});"
        )
        print("create", made, flush=True)
        view = m.js("return Services.astraHost.Profiles.get().then(r=>JSON.stringify(r));")
        data = json.loads(view or "{}")
        created = next((p["id"] for p in data.get("profiles", []) if p.get("name") == "Switch Probe"), None)
        print("profile", created, flush=True)
        switched = m.js("return Services.astraHost.Profiles.switch({profile:" + json.dumps(created) + "});")
        print("switch", switched, flush=True)
        time.sleep(4)
        after = len(subprocess.run(["pgrep", "-f", FIREFOX], capture_output=True, text=True).stdout.split())
        print("processes", before, after, flush=True)
        alive = m.js("return Services.astraHost.Tabs.list({request_id:'still'}).then(r=>!!r.tabs);")
        print("current window alive", alive, flush=True)
        # Clean up the launched profile process, then the roster entry.
        subprocess.run(["pkill", "-f", created], capture_output=True)
        time.sleep(1)
        removed = m.js("return Services.astraHost.Profiles.remove({profile:" + json.dumps(created) + "});")
        print("remove", removed, flush=True)
    finally:
        try:
            if m: m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception: pass
        time.sleep(0.5)
        try: proc.terminate(); proc.wait(timeout=10)
        except Exception: pass

main()
