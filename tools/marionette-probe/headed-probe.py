"""Headed dev-build probe: launch Astra Firefox visibly with Marionette,
dump chrome UI state (appReady, relay, alerts, browsers, console errors)
and take a screenshot. Stdlib only.

Usage: python3 tools/marionette-probe/headed-probe.py <profile-dir> <out-dir>
"""
import json
import socket
import subprocess
import sys
import time
import os

HOST, PORT = "127.0.0.1", 2828
FIREFOX = "engine/obj-astra-linux/dist/bin/firefox"

SNAP_JS = """return JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  const app = q('[data-astra-app]');
  let conErrs = [];
  try {
    const msgs = Services.console.getMessageArray() || [];
    conErrs = msgs.map(m => { try { return String(m.message); } catch (e) { return '?'; } })
      .filter(s => /astra|BridgeError|browser-chrome|remoteTab|NS_ERROR|crash/i.test(s))
      .slice(-20);
  } catch (e) { conErrs = ['con-read-ERR:' + (e && e.message)]; }
  return {
    appReady: app?.dataset?.appReady ?? null,
    relaySeen: app?.dataset?.relaySeen ?? null,
    relayLast: app?.dataset?.relayLast ?? null,
    appAlert: document.querySelector('.astra-app-mount [role=alert]')?.textContent?.slice(0,300) ?? null,
    slotAlert: document.querySelector('.astra-content [role=alert]')?.textContent?.slice(0,200) ?? null,
    browsers: [...document.querySelectorAll('browser')].map(b => {
      let s = null; try { s = b.currentURI.spec; } catch (e) { s = 'ERR'; }
      return s || '?';
    }),
    title: document.title,
    conErrs,
  };
})())"""


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("server closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("server closed mid-message")
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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]


def grim_shot(out_path):
    """Screenshot the live Astra window (class firefox-default, title Astra),
    skipping any crash-reporter dialog."""
    import json as _json
    try:
        clients = _json.loads(subprocess.run(
            ["hyprctl", "clients", "-j"], capture_output=True,
            timeout=10).stdout or b"[]")
    except Exception as e:
        return f"hyprctl-ERR {e}"
    wins = [c for c in clients
            if c.get("class") == "firefox-default"
            and "crash" not in c.get("title", "").lower()
            and "Astra" in c.get("title", "")]
    if not wins:
        return "no-our-window"
    wins.sort(key=lambda c: c["size"][0] * c["size"][1], reverse=True)
    w = wins[0]
    geom = f"{w['at'][0]},{w['at'][1]} {w['size'][0]}x{w['size'][1]}"
    env = dict(os.environ, WAYLAND_DISPLAY="wayland-1")
    try:
        subprocess.run(["grim", "-g", geom, out_path],
                       capture_output=True, timeout=30, env=env, check=True)
        return f"ok {geom} :: {w.get('title','')[:60]}"
    except Exception as e:
        return f"grim-ERR {e}"


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "--marionette", "-marionette-port", str(PORT), "about:blank"],
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
        stdout=errlog, stderr=subprocess.STDOUT)
    print(f"launched pid={proc.pid}", flush=True)
    m = None
    for _ in range(60):
        try:
            m = Marionette(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-CAME-UP");
        proc.terminate()
        return
    print("marionette connected", flush=True)
    time.sleep(20)  # let the shell + app boot
    try:
        snap = json.loads(m.cmd("WebDriver:ExecuteScript", {"script": SNAP_JS, "args": []})["value"])
    except Exception as e:
        snap = {"poll_error": str(e)[:300]}
    with open(os.path.join(outdir, "snap.json"), "w") as f:
        json.dump(snap, f, indent=1)
    print("SNAP: " + json.dumps(snap)[:1500], flush=True)
    try:
        shot = m.cmd("WebDriver:TakeScreenshot", {})
        import base64
        with open(os.path.join(outdir, "shot.png"), "wb") as f:
            f.write(base64.b64decode(shot["value"]))
        print("screenshot ok", flush=True)
    print("GRIM: " + grim_shot(os.path.join(outdir, "grim.png")), flush=True)
    except Exception as e:
        print(f"screenshot-ERR {e}", flush=True)
    proc.terminate()
    print("done", flush=True)


main()
