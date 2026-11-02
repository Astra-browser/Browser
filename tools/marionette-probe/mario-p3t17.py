"""P3-T17 deterministic boot repro harness (stdlib only).

Launches our build with a fresh profile, then polls chrome DOM + console
errors + screenshots over time, creates fresh tabs mid-run, and records the
outcome ({painted, whitebox, crash}) to a JSONL log.

Usage:
  python3 tools/marionette-probe/mario-p3t17.py <profile-dir> <out-dir> [--wait 150]

Exit 0 always (outcome is in the log); prints a one-line verdict.
"""
import json
import socket
import subprocess
import sys
import time
import os

HOST, PORT = "127.0.0.1", 2828
FIREFOX = "engine/obj-astra-linux/dist/bin/firefox"


class Marionette:
    def __init__(self):
        self.sock = socket.create_connection((HOST, PORT), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()  # handshake

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
                    raise RuntimeError(
                        f"{method} -> {msg[2]}: {json.dumps(msg[3])[:800]}")
                return msg[3]


SNAP_JS = """return JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  const app = q('[data-astra-app]');
  let gtabs = null;
  try {
    const gb = window.gBrowser;
    if (gb && gb.tabs) gtabs = [...gb.tabs].map(t => ({label: t.label, crashed: !!t.hasAttribute('crashed')}));
  } catch (e) { gtabs = 'ERR:' + (e && e.message); }
  let conErrs = [];
  try {
    const msgs = Services.console.getMessageArray() || [];
    conErrs = msgs.map(m => { try { return String(m.message); } catch (e) { return '?'; } })
      .filter(s => /astra|browser-chrome|remoteTab|messageManager|getLoadContext|NS_ERROR|tabcrashed|crash/i.test(s))
      .slice(-15);
  } catch (e) { conErrs = ['con-read-ERR:' + (e && e.message)]; }
  return {
    t: Math.round(performance.now() / 1000),
    appReady: app?.dataset?.appReady ?? null,
    relaySeen: app?.dataset?.relaySeen ?? null,
    relayLast: app?.dataset?.relayLast ?? null,
    relayHelloError: app?.dataset?.relayHelloError ?? null,
    appAlert: document.querySelector('.astra-app-mount [role=alert]')?.textContent?.slice(0,300) ?? null,
    slotAlert: document.querySelector('.astra-content [role=alert]')?.textContent?.slice(0,200) ?? null,
    hiddenCount: [...document.querySelectorAll('[hidden]')].length,
    browsers: [...document.querySelectorAll('browser')].map(b => {
      let s = null, ct = null;
      try { s = b.currentURI.spec; } catch (e) { s = 'ERR'; }
      try { ct = b.contentTitle || null; } catch (e) {}
      return (s || '?') + ' :: ' + (ct || '');
    }),
    title: document.title,
    gtabs,
    conErrs,
  };
})())"""


def snap(m):
    try:
        return json.loads(m.cmd("WebDriver:ExecuteScript",
                                {"script": SNAP_JS, "args": []})["value"])
    except Exception as e:
        return {"poll_error": str(e)[:300]}


def screenshot(out_path):
    """Screenshot our build's window (class firefox-default), not the user's."""
    try:
        clients = json.loads(subprocess.run(
            ["hyprctl", "clients", "-j"], capture_output=True,
            timeout=10).stdout or b"[]")
    except Exception as e:
        return f"hyprctl-ERR {e}"
    wins = [c for c in clients if c.get("class") == "firefox-default"]
    if not wins:
        return "no-our-window"
    # biggest window = main browser window
    wins.sort(key=lambda c: c["size"][0] * c["size"][1], reverse=True)
    w = wins[0]
    geom = f"{w['at'][0]},{w['at'][1]} {w['size'][0]}x{w['size'][1]}"
    env = dict(os.environ, WAYLAND_DISPLAY="wayland-1")
    try:
        subprocess.run(["grim", "-g", geom, out_path],
                       capture_output=True, timeout=30, env=env, check=True)
        return f"ok {geom}"
    except Exception as e:
        return f"grim-ERR {e}"


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    wait = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[3] == "--wait" else 150
    os.makedirs(outdir, exist_ok=True)
    log_path = os.path.join(outdir, "poll.jsonl")
    # fresh profile
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette",
         "about:blank"],
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
        stdout=errlog, stderr=subprocess.STDOUT)
    print(f"launched pid={proc.pid}", flush=True)
    # wait for marionette
    m = None
    for _ in range(60):
        try:
            m = Marionette()
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-UP")
        return
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    log = open(log_path, "w")
    tabs_created = 0
    t0 = time.time()
    i = 0
    crashed_seen = []
    try:
        while time.time() - t0 < wait:
            i += 1
            s = snap(m)
            s["i"] = i
            s["elapsed"] = round(time.time() - t0, 1)
            log.write(json.dumps(s) + "\n")
            log.flush()
            for b in s.get("browsers", []) or []:
                if "tabcrashed" in b or "crash" in b.lower():
                    if b not in crashed_seen:
                        crashed_seen.append(b)
            # mid-run: open REAL tabs via gBrowser to test the fresh-tab crash
            # path (Host Tabs.create is stub-only and creates no real tab).
            el = s.get("elapsed", 0)
            if 35 < el < wait - 30 and tabs_created < 4 and \
                    (s.get("appReady") == "host"):
                try:
                    r = m.cmd("WebDriver:ExecuteScript", {
                        "script": """return JSON.stringify((() => {
                          try {
                            const gb = window.gBrowser;
                            if (!gb) return {nogbrowser: true};
                            const tab = gb.addTab('about:blank', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
                            tab.linkedBrowser.loadURI(Services.io.newURI('about:blank'), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
                            return {tabs: gb.tabs.length, selected: gb.selectedTab === tab};
                          } catch (e) { return {err: String(e && e.message || e).slice(0,200)}; }
                        })())""",
                        "args": []})["value"]
                    s2 = {"tab_create": r}
                    log.write(json.dumps(s2) + "\n")
                    tabs_created += 1
                except Exception as e:
                    log.write(json.dumps({"tab_create_err": str(e)[:200]}) + "\n")
            if i in (1, 6, 12, 24):
                s["shot"] = screenshot(os.path.join(outdir, f"shot-{i}.png"))
                log.write(json.dumps({"shot": s["shot"], "i": i}) + "\n")
            time.sleep(5)
    finally:
        log.write(json.dumps({"crashed_seen": crashed_seen,
                              "tabs_created": tabs_created}) + "\n")
        log.close()
    # verdict
    print(f"VERDICT crashed={crashed_seen} tabs_created={tabs_created} log={log_path}", flush=True)


if __name__ == "__main__":
    main()
